#!/usr/bin/env node
'use strict';

const path = require('path');
const PROJECT = process.env.OMNIROUTE_PROJECT || '/a0/usr/projects/omniroute';
const DB_PATH = process.env.OMNIROUTE_DB || '/var/lib/omniroute/storage.sqlite';
const Database = require(path.join(PROJECT, 'node_modules/better-sqlite3'));

function mask(value) {
  if (!value) return '';
  const s = String(value);
  if (s.includes('@')) {
    const [local, domain] = s.split('@');
    return (local[0] || '*') + '***@' + (domain && domain[0] || '*') + '***';
  }
  if (s.length <= 8) return s[0] + '***';
  return s.slice(0, 3) + '***' + s.slice(-3);
}

function parseJson(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const now = Date.now();
const soonMs = Number(process.env.CLAUDE_OAUTH_SOON_MS || 2 * 60 * 60 * 1000);
const db = new Database(DB_PATH, { readonly: true });
try {
  const rows = db.prepare("SELECT id, name, email, is_active, priority, test_status, error_code, last_error_at, last_error_type, last_error_source, expires_at, health_check_interval, refresh_token, access_token, provider_specific_data FROM provider_connections WHERE provider = 'claude' ORDER BY is_active DESC, priority ASC, updated_at DESC").all();
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_claude_healthcheck_off_%' ORDER BY name").all().map(r => r.name);
  const accounts = rows.map((row) => {
    const meta = parseJson(row.provider_specific_data);
    const label = row.name || row.email || meta.accountEmail || row.id;
    const expiresMs = row.expires_at ? Date.parse(row.expires_at) : null;
    const expiresInSec = Number.isFinite(expiresMs) ? Math.round((expiresMs - now) / 1000) : null;
    return {
      id: row.id,
      name: mask(label),
      active: row.is_active === 1,
      priority: row.priority,
      status: row.test_status || null,
      errorCode: row.error_code || null,
      lastErrorAt: row.last_error_at || null,
      lastErrorType: row.last_error_type || null,
      lastErrorSource: row.last_error_source || null,
      expiresAt: row.expires_at || null,
      expiresInSec,
      expiringSoon: row.is_active === 1 && Number.isFinite(expiresMs) && expiresMs - now < soonMs,
      hasRefreshToken: !!row.refresh_token,
      hasAccessToken: !!row.access_token,
      healthCheckInterval: row.health_check_interval,
      authMethod: meta.authMethod || null,
      noRefresh: meta.noRefresh === true,
    };
  });
  const summary = {
    ok: true,
    checkedAt: new Date(now).toISOString(),
    total: accounts.length,
    active: accounts.filter(a => a.active).length,
    invalidGrant: accounts.filter(a => a.errorCode === 'invalid_grant').length,
    missingRefreshToken: accounts.filter(a => a.active && !a.hasRefreshToken && a.authMethod !== 'long_lived_access_token' && !a.noRefresh).length,
    expiringSoon: accounts.filter(a => a.expiringSoon).length,
    unsafeHealthChecks: accounts.filter(a => a.healthCheckInterval !== 0 && a.healthCheckInterval !== null).length,
    longLivedAccessOnly: accounts.filter(a => a.authMethod === 'long_lived_access_token' || a.noRefresh).length,
    healthCheckTriggers: triggers,
    accounts,
  };
  console.log(JSON.stringify(summary));
  if (summary.missingRefreshToken || summary.unsafeHealthChecks) process.exitCode = 2;
} finally {
  db.close();
}
