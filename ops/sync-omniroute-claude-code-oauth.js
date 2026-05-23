#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PROJECT = '/a0/usr/projects/omniroute';
const DB_PATH = '/var/lib/omniroute/storage.sqlite';
const CREDENTIALS_PATH = '/root/.claude/.credentials.json';
const SYNC_META_PATH = '/root/.claude/.omniroute-sync.json';
const RUNTIME_ENV_PATH = '/root/.claude/.omniroute-runtime-env.json';
const ROTATOR_PATH = '/usr/local/sbin/omniroute-claude-quota-rotate.js';
const LIMIT_CACHE_PATH = '/usr/local/sbin/claude-long-lived-limit-cache.js';
const REFRESH_BEFORE_MS = 2 * 60 * 60 * 1000;
const LONG_LIVED_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const FORCE = process.argv.includes('--force');
const QUIET = process.argv.includes('--quiet');
const MARK_USE = process.argv.includes('--mark-use') || process.env.CLAUDE_ROTATE_MARK_USE === '1';
function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}
const SELECT_CONNECTION_ID = argValue('--connection-id') || process.env.CLAUDE_SYNC_CONNECTION_ID || '';
const DEFAULT_SCOPES = Object.freeze([
  'user:inference',
  'user:profile',
  'user:mcp_servers',
  'user:sessions:claude_code',
]);

function log(obj) {
  if (!QUIET) console.log(JSON.stringify(obj));
}

function parseEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function classify(tok) {
  if (!tok) return null;
  return {
    kind: tok.startsWith('sk-ant-oat') ? 'access' : tok.startsWith('sk-ant-ort') ? 'refresh' : 'other',
    len: tok.length,
  };
}

function hashToken(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeScopes(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const out = [];
  for (const item of raw) {
    const parts = String(item || '').split(/[\s,]+/);
    for (const part of parts) {
      const scope = part.trim();
      if (!scope || !scope.startsWith('user:')) continue;
      if (!out.includes(scope)) out.push(scope);
    }
  }
  return out;
}

function loadDb() {
  const Database = require(path.join(PROJECT, 'node_modules/better-sqlite3'));
  return new Database(DB_PATH);
}

const env = parseEnv(path.join(PROJECT, '.env'));
const secret = env.STORAGE_ENCRYPTION_KEY;
if (!secret) throw new Error('STORAGE_ENCRYPTION_KEY missing in OmniRoute .env');
const key = crypto.scryptSync(secret, 'omniroute-field-encryption-v1', 32);
const PREFIX = 'enc:v1:';

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

function readClaudeCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function parseProviderData(row) {
  try { return row.provider_specific_data ? JSON.parse(row.provider_specific_data) : {}; }
  catch { return {}; }
}

function isLongLivedAccessOnly(row, accessToken, refreshToken) {
  const data = parseProviderData(row);
  return data.authMethod === 'long_lived_access_token' || data.noRefresh === true || (!!accessToken && !refreshToken && String(accessToken).startsWith('sk-ant-oat'));
}

function writeSyncMetadata(row, accessToken, refreshToken, expiresAtMs, authMethod) {
  fs.mkdirSync(path.dirname(SYNC_META_PATH), { recursive: true, mode: 0o700 });
  const out = {
    provider: 'claude',
    connectionId: row.id,
    connectionName: row.name || null,
    authMethod,
    syncedAt: new Date().toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    accessHash: hashToken(accessToken),
    refreshHash: hashToken(refreshToken),
  };
  fs.writeFileSync(SYNC_META_PATH, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(SYNC_META_PATH, 0o600);
}

function writeRuntimeEnv(row, accessToken, expiresAtMs) {
  fs.mkdirSync(path.dirname(RUNTIME_ENV_PATH), { recursive: true, mode: 0o700 });
  const out = {
    provider: 'claude',
    connectionId: row.id,
    connectionName: row.name || null,
    authMethod: 'long_lived_access_token',
    writtenAt: new Date().toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    accessHash: hashToken(accessToken),
    CLAUDE_CODE_OAUTH_TOKEN: accessToken,
  };
  fs.writeFileSync(RUNTIME_ENV_PATH, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(RUNTIME_ENV_PATH, 0o600);
}

function clearRuntimeEnv() {
  try { fs.rmSync(RUNTIME_ENV_PATH, { force: true }); } catch {}
}

function writeClaudeCredentials(accessToken, refreshToken, expiresAtMs, scopes) {
  fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  const existing = readClaudeCredentials();
  const old = existing.claudeAiOauth || {};
  const out = {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt: expiresAtMs,
      scopes:
        normalizeScopes(scopes).length
          ? normalizeScopes(scopes)
          : normalizeScopes(old.scopes).length
            ? normalizeScopes(old.scopes)
            : [...DEFAULT_SCOPES],
      subscriptionType: old.subscriptionType || 'max',
      rateLimitTier: old.rateLimitTier || 'max',
    },
  };
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(CREDENTIALS_PATH, 0o600);
}

async function refresh(refreshToken) {
  if (!refreshToken) throw new Error('refresh token missing');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id:
      process.env.CLAUDE_OAUTH_CLIENT_ID ||
      env.CLAUDE_OAUTH_CLIENT_ID ||
      '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  });
  const resp = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: params.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    const safe = text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-token]');
    throw new Error(`refresh failed status=${resp.status} body=${safe.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

function seedLongLivedLimitCache() {
  if (!fs.existsSync(LIMIT_CACHE_PATH)) return;
  const result = spawnSync(process.execPath, [LIMIT_CACHE_PATH, '--quiet'], {
    cwd: PROJECT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30 * 1000,
  });
  if (!QUIET && (result.error || result.status !== 0)) {
    const errorText = result.error
      ? result.error.message
      : (result.stderr && result.stderr.toString('utf8').trim()) || 'unknown error';
    console.error(JSON.stringify({ warning: 'long-lived quota cache seed failed', error: errorText }));
  }
}

function selectConnection(db) {
  const fields = 'id, name, access_token, refresh_token, expires_at, scope, provider_specific_data';
  if (SELECT_CONNECTION_ID) {
    const row = db.prepare(`SELECT ${fields} FROM provider_connections WHERE provider = 'claude' AND is_active = 1 AND id = ?`).get(SELECT_CONNECTION_ID);
    if (!row) throw new Error(`Requested Claude connection is not active or not found: ${SELECT_CONNECTION_ID}`);
    return { row, selection: { selected: { id: row.id, score: null, rotationScore: null }, thresholds: null } };
  }
  if (fs.existsSync(ROTATOR_PATH)) {
    const { rotateClaudeConnections } = require(ROTATOR_PATH);
    const selection = rotateClaudeConnections(db, { apply: true });
    if (!selection.selected) {
      throw new Error(`No quota-eligible OmniRoute Claude connection found; thresholds=${JSON.stringify(selection.thresholds)}`);
    }
    const row = db.prepare(`SELECT ${fields} FROM provider_connections WHERE id = ?`).get(selection.selected.id);
    if (!row) throw new Error(`Selected Claude connection disappeared: ${selection.selected.id}`);
    return { row, selection };
  }

  const row = db
    .prepare(
      `SELECT ${fields}
         FROM provider_connections
        WHERE provider = 'claude'
          AND is_active = 1
          AND (rate_limited_until IS NULL OR rate_limited_until <= ?)
        ORDER BY priority ASC, updated_at DESC
        LIMIT 1`
    )
    .get(new Date().toISOString());
  if (!row) throw new Error('No active OmniRoute Claude provider connection found');
  return { row, selection: null };
}

(async () => {
  seedLongLivedLimitCache();
  const db = loadDb();
  const { row, selection } = selectConnection(db);
  let accessToken = decrypt(row.access_token);
  let refreshToken = decrypt(row.refresh_token);
  let expiresAtMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  let scopeText = row.scope || '';
  let scopes = normalizeScopes(scopeText);
  let remainingMs = Number.isFinite(expiresAtMs) ? expiresAtMs - Date.now() : -1;
  let refreshed = false;
  let authMethod = isLongLivedAccessOnly(row, accessToken, refreshToken) ? 'long_lived_access_token' : 'oauth_refresh';

  if (!accessToken) throw new Error('selected Claude connection has no access token');

  if (authMethod === 'long_lived_access_token') {
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + LONG_LIVED_EXPIRY_BUFFER_MS) {
      throw new Error('selected long-lived Claude token is expired or has no valid expires_at');
    }
    clearRuntimeEnv();
    writeRuntimeEnv(row, accessToken, expiresAtMs);
    writeSyncMetadata(row, accessToken, null, expiresAtMs, authMethod);
  } else {
    clearRuntimeEnv();
    if (FORCE || remainingMs < REFRESH_BEFORE_MS || !accessToken || !refreshToken) {
      const tokens = await refresh(refreshToken);
      accessToken = tokens.access_token;
      refreshToken = tokens.refresh_token || refreshToken;
      const expiresIn = Number(tokens.expires_in || 28800);
      expiresAtMs = Date.now() + expiresIn * 1000;
      remainingMs = expiresAtMs - Date.now();
      scopeText = tokens.scope || scopeText || scopes.join(' ');
      scopes = normalizeScopes(scopeText).length ? normalizeScopes(scopeText) : scopes;
      db.prepare(
        `UPDATE provider_connections
            SET access_token = ?,
                refresh_token = ?,
                expires_at = ?,
                token_expires_at = ?,
                expires_in = ?,
                scope = ?,
                test_status = 'active',
                error_code = NULL,
                last_error = NULL,
                last_error_at = NULL,
                last_error_type = NULL,
                last_error_source = NULL,
                rate_limited_until = NULL,
                updated_at = ?
          WHERE id = ?`
      ).run(
        encrypt(accessToken),
        encrypt(refreshToken),
        new Date(expiresAtMs).toISOString(),
        new Date(expiresAtMs).toISOString(),
        expiresIn,
        scopeText,
        new Date().toISOString(),
        row.id
      );
      refreshed = true;
    }
    writeClaudeCredentials(accessToken, refreshToken, expiresAtMs, scopes);
    writeSyncMetadata(row, accessToken, refreshToken, expiresAtMs, authMethod);
  }

  let usage = null;
  if (MARK_USE && selection?.selected?.id) {
    const { recordClaudeConnectionUse } = require(ROTATOR_PATH);
    usage = recordClaudeConnectionUse(db, row.id);
  }
  log({
    ok: true,
    connectionId: row.id,
    connectionName: row.name || null,
    authMethod,
    selectedScore: selection?.selected?.score ?? null,
    selectedRotationScore: selection?.selected?.rotationScore ?? null,
    markUse: MARK_USE,
    usage,
    thresholds: selection?.thresholds ?? null,
    refreshed,
    expiresISO: new Date(expiresAtMs).toISOString(),
    remainingSeconds: Math.round((expiresAtMs - Date.now()) / 1000),
    access: classify(accessToken),
    refresh: classify(refreshToken),
  });
})().catch((err) => {
  clearRuntimeEnv();
  console.error(JSON.stringify({ ok: false, error: String((err && err.message) || err).replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-token]') }));
  process.exit(1);
});
