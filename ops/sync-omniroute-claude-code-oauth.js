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
const PROVIDER_LIMITS_REFRESH_PATH = '/usr/local/sbin/omniroute-provider-limits-refresh.sh';
const IMPORT_PATH = '/usr/local/sbin/import-claude-code-oauth-to-omniroute.js';
const BOT_ROOT = '/a0/usr/projects/telegram_claude_bot';
const ROUTE_LEASE_DIR = process.env.CLAUDE_ROUTE_LEASE_DIR || '/run/omniroute-claude-route-leases';
const REFRESH_BEFORE_MS = 2 * 60 * 60 * 1000;
const LONG_LIVED_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const FORCE = process.argv.includes('--force');
const QUIET = process.argv.includes('--quiet');
const REFRESH_ALL = process.argv.includes('--refresh-all');
const MARK_USE = process.argv.includes('--mark-use') || process.env.CLAUDE_ROTATE_MARK_USE === '1';
const ALLOW_ESTIMATED_LONG_LIVED_QUOTA = /^(1|true|yes|on)$/i.test(String(process.env.CLAUDE_ALLOW_ESTIMATED_LONG_LIVED_QUOTA || ''));
const SKIP_PROVIDER_LIMITS_REFRESH = process.argv.includes('--skip-provider-limits') || /^(1|true|yes|on)$/i.test(String(process.env.CLAUDE_SYNC_SKIP_PROVIDER_LIMITS_REFRESH || ''));
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

function clearSyncedClaudeAuth() {
  clearRuntimeEnv();
  try { fs.rmSync(CREDENTIALS_PATH, { force: true }); } catch {}
  try { fs.rmSync(SYNC_META_PATH, { force: true }); } catch {}
}

function recoverBotRunCredentials() {
  if (!fs.existsSync(IMPORT_PATH) || !fs.existsSync(BOT_ROOT)) return { ok: true, skipped: true, reason: 'import script or bot root missing' };
  const find = spawnSync('find', [BOT_ROOT, '-path', '*/home/.claude/.omniroute-sync.json', '-type', 'f', '-mtime', '-14', '-print0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30 * 1000,
  });
  if (find.error || find.status !== 0) {
    return { ok: false, error: find.error ? find.error.message : (find.stderr || '').toString('utf8').slice(-500) };
  }
  const metas = (find.stdout || Buffer.alloc(0)).toString('utf8').split('\0').filter(Boolean);
  let checked = 0;
  let imported = 0;
  for (const meta of metas) {
    const home = meta.slice(0, -'/.claude/.omniroute-sync.json'.length);
    if (!home || !fs.existsSync(path.join(home, '.claude', '.credentials.json'))) continue;
    checked += 1;
    const result = spawnSync(process.execPath, [IMPORT_PATH, '--home', home, '--quiet'], {
      cwd: PROJECT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30 * 1000,
    });
    if (!result.error && result.status === 0) imported += 1;
  }
  return { ok: true, checked, imported };
}

function liveRouteLeaseConnectionIds() {
  const ids = new Set();
  let entries = [];
  try { entries = fs.readdirSync(ROUTE_LEASE_DIR, { withFileTypes: true }); } catch { return ids; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(ROUTE_LEASE_DIR, entry.name);
    let lease = null;
    try { lease = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!lease || lease.provider !== 'claude' || !lease.connectionId) continue;
    const pid = Number(lease.ownerPid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); } catch { continue; }
    ids.add(lease.connectionId);
  }
  return ids;
}

function refreshableClaudeRows(db) {
  const fields = 'id, name, access_token, refresh_token, expires_at, scope, provider_specific_data';
  return db.prepare(`SELECT ${fields} FROM provider_connections WHERE provider = 'claude' AND (is_active = 1 OR (refresh_token IS NOT NULL AND COALESCE(error_code, '') NOT IN ('invalid_grant', 'invalid_auth_credentials') AND COALESCE(test_status, '') != 'expired')) ORDER BY is_active DESC, priority ASC, updated_at DESC`).all();
}

async function refreshConnectionTokens(db, row, options = {}) {
  let accessToken = decrypt(row.access_token);
  let refreshToken = decrypt(row.refresh_token);
  let expiresAtMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  let scopeText = row.scope || '';
  let scopes = normalizeScopes(scopeText);
  const remainingMs = Number.isFinite(expiresAtMs) ? expiresAtMs - Date.now() : -1;
  const authMethod = isLongLivedAccessOnly(row, accessToken, refreshToken) ? 'long_lived_access_token' : 'oauth_refresh';

  if (authMethod === 'long_lived_access_token') {
    return { id: row.id, name: row.name || null, ok: true, skipped: true, reason: 'long-lived access-only' };
  }
  if (!refreshToken) {
    return { id: row.id, name: row.name || null, ok: false, skipped: true, reason: 'missing refresh token' };
  }
  if (!options.force && accessToken && Number.isFinite(remainingMs) && remainingMs >= REFRESH_BEFORE_MS) {
    return { id: row.id, name: row.name || null, ok: true, refreshed: false, remainingSeconds: Math.round(remainingMs / 1000) };
  }

  let tokens;
  try {
    tokens = await refresh(refreshToken);
  } catch (err) {
    markInvalidRefreshToken(db, row, err);
    return { id: row.id, name: row.name || null, ok: false, refreshed: false, error: String((err && err.message) || err).replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-token]') };
  }

  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token || refreshToken;
  const expiresIn = Number(tokens.expires_in || 28800);
  expiresAtMs = Date.now() + expiresIn * 1000;
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
            is_active = 1,
            updated_at = ?
      WHERE id = ? AND provider = 'claude'`
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
  return { id: row.id, name: row.name || null, ok: true, refreshed: true, expiresISO: new Date(expiresAtMs).toISOString(), remainingSeconds: Math.round((expiresAtMs - Date.now()) / 1000) };
}

async function refreshAllExpiringClaudeConnections(db, options = {}) {
  const leased = liveRouteLeaseConnectionIds();
  const rows = refreshableClaudeRows(db);
  const accounts = [];
  for (const row of rows) {
    if (leased.has(row.id)) {
      accounts.push({ id: row.id, name: row.name || null, ok: true, skipped: true, reason: 'active route lease' });
      continue;
    }
    accounts.push(await refreshConnectionTokens(db, row, options));
  }
  return {
    ok: true,
    checked: accounts.length,
    refreshed: accounts.filter((item) => item.refreshed).length,
    failed: accounts.filter((item) => item.ok === false).length,
    skipped: accounts.filter((item) => item.skipped).length,
    accounts,
  };
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

function markInvalidRefreshToken(db, row, err) {
  const message = String((err && err.message) || err || '');
  if (!/invalid_grant/i.test(message) || !row || !row.id) return;
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE provider_connections
        SET is_active = 0,
            test_status = 'expired',
            error_code = 'invalid_grant',
            last_error = ?,
            last_error_at = ?,
            last_error_type = 'invalid_grant',
            last_error_source = 'oauth',
            rate_limited_until = NULL,
            priority = CASE WHEN priority < 99 THEN 99 ELSE priority END,
            updated_at = ?
      WHERE id = ? AND provider = 'claude'`
  ).run('OAuth refresh failed: invalid_grant', nowIso, nowIso, row.id);
}

function refreshProviderLimitsCache() {
  if (SELECT_CONNECTION_ID || SKIP_PROVIDER_LIMITS_REFRESH) return null;
  if (!fs.existsSync(PROVIDER_LIMITS_REFRESH_PATH)) return { ok: false, reason: 'provider limits refresh script missing' };
  const result = spawnSync(PROVIDER_LIMITS_REFRESH_PATH, [], {
    cwd: PROJECT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 150 * 1000,
  });
  const stdout = result.stdout ? result.stdout.toString('utf8').trim() : '';
  const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
  const ok = !result.error && result.status === 0;
  if (!ok && !QUIET) {
    console.error(JSON.stringify({
      warning: 'provider limits refresh failed',
      status: result.status,
      error: result.error ? result.error.message : null,
      stdout: stdout.slice(-500),
      stderr: stderr.slice(-500),
    }));
  }
  return { ok, status: result.status, stdout: stdout.slice(-500), stderr: stderr.slice(-500) };
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
  const recovery = recoverBotRunCredentials();
  if (ALLOW_ESTIMATED_LONG_LIVED_QUOTA) seedLongLivedLimitCache();
  const db = loadDb();
  const fleetRefresh = await refreshAllExpiringClaudeConnections(db, { force: FORCE && REFRESH_ALL });
  if (REFRESH_ALL) {
    log({ ok: true, mode: 'refresh-all', recovery, fleetRefresh });
    return;
  }
  refreshProviderLimitsCache();
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
    clearSyncedClaudeAuth();
    writeRuntimeEnv(row, accessToken, expiresAtMs);
    writeSyncMetadata(row, accessToken, null, expiresAtMs, authMethod);
  } else {
    clearRuntimeEnv();
    if (FORCE || remainingMs < REFRESH_BEFORE_MS || !accessToken || !refreshToken) {
      const result = await refreshConnectionTokens(db, row, { force: true });
      if (!result.ok) throw new Error(result.error || result.reason || 'Claude OAuth refresh failed');
      refreshed = !!result.refreshed;
      const updated = db.prepare('SELECT access_token, refresh_token, expires_at, scope FROM provider_connections WHERE id = ? AND provider = ?').get(row.id, 'claude');
      accessToken = decrypt(updated.access_token);
      refreshToken = decrypt(updated.refresh_token);
      expiresAtMs = updated.expires_at ? new Date(updated.expires_at).getTime() : expiresAtMs;
      remainingMs = Number.isFinite(expiresAtMs) ? expiresAtMs - Date.now() : remainingMs;
      scopeText = updated.scope || scopeText;
      scopes = normalizeScopes(scopeText).length ? normalizeScopes(scopeText) : scopes;
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
    fleetRefresh: { checked: fleetRefresh.checked, refreshed: fleetRefresh.refreshed, failed: fleetRefresh.failed, skipped: fleetRefresh.skipped },
    refreshed,
    expiresISO: new Date(expiresAtMs).toISOString(),
    remainingSeconds: Math.round((expiresAtMs - Date.now()) / 1000),
    access: classify(accessToken),
    refresh: classify(refreshToken),
  });
})().catch((err) => {
  clearSyncedClaudeAuth();
  console.error(JSON.stringify({ ok: false, error: String((err && err.message) || err).replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-token]') }));
  process.exit(1);
});
