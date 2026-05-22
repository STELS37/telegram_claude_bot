#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT = process.env.OMNIROUTE_PROJECT || '/a0/usr/projects/omniroute';
const DB_PATH = process.env.OMNIROUTE_DB || '/var/lib/omniroute/storage.sqlite';
const PREFIX = 'enc:v1:';
const SESSION_WINDOW = 'session (5h)';
const WEEKLY_WINDOW = 'weekly (7d)';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { scope: 'user:inference', name: null, expiresAt: null, tokenFile: null, token: null, initialRemaining: 100 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' && args[i + 1]) out.name = args[++i];
    else if (a === '--expires-at' && args[i + 1]) out.expiresAt = args[++i];
    else if (a === '--token-file' && args[i + 1]) out.tokenFile = args[++i];
    else if (a === '--token' && args[i + 1]) out.token = args[++i];
    else if (a === '--scope' && args[i + 1]) out.scope = args[++i];
    else if (a === '--initial-remaining' && args[i + 1]) out.initialRemaining = Number(args[++i]);
  }
  return out;
}

function parseEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('\"') && v.endsWith('\"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env = parseEnv(path.join(PROJECT, '.env'));
const secret = env.STORAGE_ENCRYPTION_KEY;
if (!secret) throw new Error('STORAGE_ENCRYPTION_KEY missing in OmniRoute .env');
const key = crypto.scryptSync(secret, 'omniroute-field-encryption-v1', 32);

function encrypt(value) {
  if (!value) return value;
  if (String(value).startsWith(PREFIX)) return value;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(String(value), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return PREFIX + iv.toString('hex') + ':' + encrypted + ':' + cipher.getAuthTag().toString('hex');
}

function decrypt(value) {
  if (!value || !String(value).startsWith(PREFIX)) return value;
  const parts = String(value).slice(PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
  let out = decipher.update(parts[1], 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseExpiresAt(value) {
  if (!value) throw new Error('--expires-at is required for long-lived tokens');
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + 'T23:59:59.000Z' : raw;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= Date.now()) throw new Error('expires-at must be a future date');
  return new Date(ms).toISOString();
}

function loadDb() {
  const Database = require(path.join(PROJECT, 'node_modules/better-sqlite3'));
  return new Database(DB_PATH);
}

function readToken(args) {
  const token = args.tokenFile ? fs.readFileSync(args.tokenFile, 'utf8').trim() : String(args.token || process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
  if (!token) throw new Error('token missing: pass --token-file or CLAUDE_CODE_OAUTH_TOKEN');
  if (!token.startsWith('sk-ant-oat')) throw new Error('expected a Claude long-lived access token starting with sk-ant-oat');
  return token;
}

function findExistingByTokenHash(db, tokenHash) {
  const rows = db.prepare("SELECT id, access_token, provider_specific_data FROM provider_connections WHERE provider = 'claude'").all();
  for (const row of rows) {
    let data = {};
    try { data = row.provider_specific_data ? JSON.parse(row.provider_specific_data) : {}; } catch {}
    if (data.tokenHash === tokenHash) return row.id;
    try { if (row.access_token && hashToken(decrypt(row.access_token)) === tokenHash) return row.id; } catch {}
  }
  return null;
}

function main() {
  const args = parseArgs();
  const token = readToken(args);
  const tokenHash = hashToken(token);
  const expiresAt = parseExpiresAt(args.expiresAt);
  const expiresIn = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
  const now = new Date().toISOString();
  const bootstrapUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const name = args.name || ('Claude long-lived ' + tokenHash.slice(0, 8));
  const initialRemaining = Math.max(0, Math.min(100, Number.isFinite(args.initialRemaining) ? args.initialRemaining : 100));
  const providerData = {
    authMethod: 'long_lived_access_token',
    tokenKind: 'CLAUDE_CODE_OAUTH_TOKEN',
    noRefresh: true,
    source: 'manual-import',
    importedAt: now,
    tokenHash,
    expiresAt,
    scope: args.scope,
    bootstrapQuotaRemaining: { [SESSION_WINDOW]: initialRemaining, [WEEKLY_WINDOW]: initialRemaining },
    bootstrapQuotaUntil: bootstrapUntil
  };
  const db = loadDb();
  try {
    const existingId = findExistingByTokenHash(db, tokenHash);
    if (existingId) {
      db.prepare("UPDATE provider_connections SET name = ?, display_name = ?, access_token = ?, refresh_token = NULL, expires_at = ?, token_expires_at = ?, expires_in = ?, scope = ?, test_status = 'active', error_code = NULL, last_error = NULL, last_error_at = NULL, last_error_type = NULL, last_error_source = NULL, is_active = 1, auth_type = 'oauth', health_check_interval = 0, provider_specific_data = ?, updated_at = ? WHERE id = ?").run(name, name, encrypt(token), expiresAt, expiresAt, expiresIn, args.scope, JSON.stringify(providerData), now, existingId);
      console.log(JSON.stringify({ ok: true, action: 'updated', id: existingId, name, expiresAt, tokenHash: tokenHash.slice(0, 12) }));
      return;
    }
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO provider_connections (id, provider, auth_type, name, email, priority, is_active, access_token, refresh_token, expires_at, token_expires_at, scope, project_id, test_status, error_code, last_error, last_error_at, last_error_type, last_error_source, backoff_level, rate_limited_until, health_check_interval, last_health_check_at, last_tested, api_key, id_token, provider_specific_data, expires_in, display_name, global_priority, default_model, token_type, consecutive_use_count, rate_limit_protection, last_used_at, \"group\", max_concurrent, quota_window_thresholds_json, created_at, updated_at) VALUES (?, 'claude', 'oauth', ?, NULL, 1, 1, ?, NULL, ?, ?, ?, NULL, 'active', NULL, NULL, NULL, NULL, NULL, 0, NULL, 0, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, 'claude-opus-4-7', 'Bearer', 0, 1, NULL, 'long-lived', 1, NULL, ?, ?)").run(id, name, encrypt(token), expiresAt, expiresAt, args.scope, JSON.stringify(providerData), expiresIn, name, now, now);
    console.log(JSON.stringify({ ok: true, action: 'inserted', id, name, expiresAt, tokenHash: tokenHash.slice(0, 12) }));
  } finally {
    db.close();
  }
}

main();
