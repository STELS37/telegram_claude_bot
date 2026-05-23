#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT = process.env.OMNIROUTE_PROJECT || '/a0/usr/projects/omniroute';
const DB_PATH = process.env.OMNIROUTE_DB || '/var/lib/omniroute/storage.sqlite';
const META_NAME = '.omniroute-sync.json';
const CREDENTIALS_NAME = '.credentials.json';
const PREFIX = 'enc:v1:';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { home: process.env.HOME || '/root', quiet: args.includes('--quiet') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--home' && args[i + 1]) out.home = args[++i];
    else if (args[i] === '--credentials' && args[i + 1]) out.credentials = args[++i];
    else if (args[i] === '--meta' && args[i + 1]) out.meta = args[++i];
  }
  return out;
}

function log(obj, quiet) {
  if (!quiet) console.log(JSON.stringify(obj));
}

function parseEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env = parseEnv(path.join(PROJECT, '.env'));
const secret = env.STORAGE_ENCRYPTION_KEY;
if (!secret) throw new Error('STORAGE_ENCRYPTION_KEY missing in OmniRoute .env');
const key = crypto.scryptSync(secret, 'omniroute-field-encryption-v1', 32);

function decrypt(value) {
  if (!value || !String(value).startsWith(PREFIX)) return value;
  const [ivHex, encryptedHex, authTagHex] = String(value).slice(PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let out = decipher.update(encryptedHex, 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

function encrypt(value) {
  if (!value) return value;
  if (String(value).startsWith(PREFIX)) return value;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(String(value), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return PREFIX + iv.toString('hex') + ':' + encrypted + ':' + cipher.getAuthTag().toString('hex');
}

function hashToken(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadDb() {
  const Database = require(path.join(PROJECT, 'node_modules/better-sqlite3'));
  return new Database(DB_PATH);
}

function sameMinuteIso(a, b) {
  const am = Date.parse(a || '');
  const bm = Date.parse(b || '');
  if (!Number.isFinite(am) || !Number.isFinite(bm)) return false;
  return Math.abs(am - bm) < 60 * 1000;
}

(function main() {
  const args = parseArgs();
  const claudeDir = path.join(args.home, '.claude');
  const credentialsPath = args.credentials || path.join(claudeDir, CREDENTIALS_NAME);
  const metaPath = args.meta || path.join(claudeDir, META_NAME);

  if (!fs.existsSync(credentialsPath) || !fs.existsSync(metaPath)) {
    log({ ok: true, skipped: true, reason: 'missing credentials or metadata' }, args.quiet);
    return;
  }

  const meta = readJson(metaPath);
  if (meta.provider !== 'claude' || !meta.connectionId) {
    log({ ok: true, skipped: true, reason: 'not an OmniRoute Claude sync metadata file' }, args.quiet);
    return;
  }
  if (meta.authMethod === 'long_lived_access_token' || meta.refreshHash === null) {
    log({ ok: true, skipped: true, reason: 'long-lived access token has no refresh import path', connectionId: meta.connectionId }, args.quiet);
    return;
  }

  const creds = readJson(credentialsPath);
  const oauth = creds.claudeAiOauth || {};
  const accessToken = oauth.accessToken || null;
  const refreshToken = oauth.refreshToken || null;
  const expiresAtMs = Number(oauth.expiresAt || 0);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    log({ ok: false, skipped: true, reason: 'Claude credentials incomplete', connectionId: meta.connectionId }, args.quiet);
    process.exitCode = 2;
    return;
  }

  const db = loadDb();
  try {
    const row = db.prepare('SELECT id, provider, is_active, access_token, refresh_token, expires_at, updated_at, test_status, error_code, last_error_type FROM provider_connections WHERE id = ?').get(meta.connectionId);
    if (!row || row.provider !== 'claude') {
      log({ ok: false, skipped: true, reason: 'connection not found or not Claude', connectionId: meta.connectionId }, args.quiet);
      process.exitCode = 2;
      return;
    }

    const currentRefresh = decrypt(row.refresh_token);
    const currentAccess = decrypt(row.access_token);
    const currentRefreshHash = hashToken(currentRefresh);
    const newRefreshHash = hashToken(refreshToken);
    const currentExpiresMs = row.expires_at ? Date.parse(row.expires_at) : 0;
    const newExpiresIso = new Date(expiresAtMs).toISOString();
    const invalidGrant = row.error_code === 'invalid_grant' || row.last_error_type === 'invalid_grant' || row.test_status === 'expired';
    if (invalidGrant && currentRefreshHash === newRefreshHash) {
      log({ ok: true, skipped: true, reason: 'same rejected refresh token', connectionId: row.id }, args.quiet);
      return;
    }

    if (currentRefresh && currentRefreshHash !== meta.refreshHash && currentExpiresMs >= expiresAtMs && !sameMinuteIso(row.expires_at, newExpiresIso)) {
      log({ ok: true, skipped: true, reason: 'DB already has a newer/different refresh token', connectionId: row.id }, args.quiet);
      return;
    }

    const changed = currentRefreshHash !== newRefreshHash || hashToken(currentAccess) !== hashToken(accessToken) || !sameMinuteIso(row.expires_at, newExpiresIso) || row.test_status === 'expired' || row.error_code === 'invalid_grant';
    if (!changed) {
      log({ ok: true, changed: false, connectionId: row.id, expiresAt: newExpiresIso }, args.quiet);
      return;
    }

    const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.join(' ') : null;
    const shouldReactivate = row.is_active === 1 || currentRefreshHash !== newRefreshHash;
    db.prepare(`UPDATE provider_connections
      SET access_token = ?,
          refresh_token = ?,
          expires_at = ?,
          token_expires_at = ?,
          expires_in = ?,
          scope = COALESCE(?, scope),
          test_status = 'active',
          error_code = NULL,
          last_error = NULL,
          last_error_at = NULL,
          last_error_type = NULL,
          last_error_source = NULL,
          is_active = CASE WHEN ? THEN 1 ELSE is_active END,
          updated_at = ?
      WHERE id = ?`).run(
        encrypt(accessToken),
        encrypt(refreshToken),
        newExpiresIso,
        newExpiresIso,
        Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000)),
        scopes,
        shouldReactivate ? 1 : 0,
        new Date().toISOString(),
        row.id
      );

    log({ ok: true, changed: true, connectionId: row.id, expiresAt: newExpiresIso, reactivated: !!shouldReactivate && row.is_active !== 1 }, args.quiet);
  } finally {
    db.close();
  }
})()
