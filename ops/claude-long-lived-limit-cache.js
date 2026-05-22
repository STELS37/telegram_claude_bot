#!/usr/bin/env node
'use strict';

const path = require('path');

const PROJECT = process.env.OMNIROUTE_PROJECT || '/a0/usr/projects/omniroute';
const DB_PATH = process.env.OMNIROUTE_DB || '/var/lib/omniroute/storage.sqlite';
const PROVIDER = 'claude';
const CACHE_NAMESPACE = 'providerLimitsCache';
const SESSION_WINDOW = 'session (5h)';
const WEEKLY_WINDOW = 'weekly (7d)';
const SONNET_WINDOW = 'weekly sonnet (7d)';
const DESIGNER_WINDOW = 'weekly designer (7d)';
const SOURCE = 'long-lived-estimated';
const CACHE_SOURCE = 'manual';
const DEFAULT_REMAINING = 100;

const quiet = process.argv.includes('--quiet');

function loadDb() {
  const Database = require(path.join(PROJECT, 'node_modules/better-sqlite3'));
  return new Database(DB_PATH);
}

function safeJson(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function parseDateMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function clampPercent(value, fallback = DEFAULT_REMAINING) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num * 100) / 100));
}

function isLongLivedAccessOnly(row, meta) {
  if (!row || row.provider !== PROVIDER || row.auth_type !== 'oauth') return false;
  if (!row.has_access_token) return false;
  if (meta.authMethod === 'long_lived_access_token') return true;
  if (meta.noRefresh === true && meta.tokenKind === 'CLAUDE_CODE_OAUTH_TOKEN') return true;
  return false;
}

function isFuture(value, nowMs) {
  const ms = parseDateMs(value);
  return ms !== null && ms > nowMs;
}

function isOwnQuotaThreshold(row) {
  if (!row) return false;
  if (row.error_code === 'quota_threshold') return true;
  if (row.last_error_source === 'quota_rotate') return true;
  return /quota threshold/i.test(String(row.last_error || ''));
}

function remainingFor(meta, windowKey) {
  const byWindow = meta.bootstrapQuotaRemaining && typeof meta.bootstrapQuotaRemaining === 'object'
    ? meta.bootstrapQuotaRemaining
    : null;
  if (byWindow && byWindow[windowKey] != null) return clampPercent(byWindow[windowKey]);
  if (meta.bootstrapQuotaRemainingPercentage != null) {
    return clampPercent(meta.bootstrapQuotaRemainingPercentage);
  }
  return DEFAULT_REMAINING;
}

function quota(remaining, resetAt = null) {
  const rem = clampPercent(remaining);
  return {
    used: Math.round((100 - rem) * 100) / 100,
    total: 100,
    remaining: rem,
    resetAt,
    remainingPercentage: rem,
    unlimited: false,
    estimated: true,
    telemetry: SOURCE,
  };
}

function buildCacheEntry(row, meta, nowMs) {
  let sessionRemaining = remainingFor(meta, SESSION_WINDOW);
  let weeklyRemaining = remainingFor(meta, WEEKLY_WINDOW);
  let sonnetRemaining = remainingFor(meta, SONNET_WINDOW);
  let designerRemaining = remainingFor(meta, DESIGNER_WINDOW);
  let sessionResetAt = null;
  let weeklyResetAt = null;

  if (isFuture(row.rate_limited_until, nowMs) && !isOwnQuotaThreshold(row)) {
    sessionRemaining = 0;
    weeklyRemaining = 0;
    sonnetRemaining = 0;
    designerRemaining = 0;
    sessionResetAt = row.rate_limited_until;
    weeklyResetAt = row.rate_limited_until;
  }

  const fetchedAt = iso(nowMs);
  return {
    quotas: {
      [SESSION_WINDOW]: quota(sessionRemaining, sessionResetAt),
      [WEEKLY_WINDOW]: quota(weeklyRemaining, weeklyResetAt),
      [SONNET_WINDOW]: quota(sonnetRemaining, weeklyResetAt),
      [DESIGNER_WINDOW]: quota(designerRemaining, null),
    },
    plan: meta.plan || meta.planName || 'Claude Code',
    message: null,
    fetchedAt,
    source: CACHE_SOURCE,
    note: 'Access-only long-lived Claude Code token. The token scope does not expose real account quota telemetry, so this is an estimated/bootstrap cache used to keep routing and UI stable.',
  };
}

function snapshotRows(entry, nowIso) {
  return Object.entries(entry.quotas).map(([windowKey, q]) => ({
    provider: PROVIDER,
    connectionId: null,
    windowKey,
    remaining: q.remainingPercentage,
    exhausted: q.remainingPercentage <= 0 ? 1 : 0,
    resetAt: q.resetAt || null,
    raw: JSON.stringify({
      source: SOURCE,
      estimated: true,
      actualUsageAvailable: false,
      reason: 'long-lived token has user:inference scope only',
      fetchedAt: entry.fetchedAt,
    }),
    createdAt: nowIso,
  }));
}

function main() {
  const nowMs = Date.now();
  const nowIso = iso(nowMs);
  const db = loadDb();
  const rows = db.prepare(`
    SELECT id, provider, auth_type, name, is_active, rate_limited_until, expires_at, scope,
           access_token IS NOT NULL AS has_access_token,
           refresh_token IS NOT NULL AS has_refresh_token,
           last_error, last_error_source, error_code,
           provider_specific_data
      FROM provider_connections
     WHERE provider = ? AND is_active = 1
  `).all(PROVIDER);

  const upsertCache = db.prepare(`
    INSERT OR REPLACE INTO key_value (namespace, key, value)
    VALUES (?, ?, ?)
  `);
  const insertSnapshot = db.prepare(`
    INSERT INTO quota_snapshots
      (provider, connection_id, window_key, remaining_percentage, is_exhausted, next_reset_at, window_duration_ms, raw_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateMeta = db.prepare(`
    UPDATE provider_connections
       SET provider_specific_data = ?, updated_at = ?
     WHERE id = ?
  `);
  const pruneOldSynthetic = db.prepare(`
    DELETE FROM quota_snapshots
     WHERE connection_id = ?
       AND raw_data LIKE '%"source":"long-lived-estimated"%'
       AND created_at < ?
  `);
  const clearOwnQuotaBlock = db.prepare(`
    UPDATE provider_connections
       SET rate_limited_until = NULL,
           error_code = NULL,
           last_error = NULL,
           last_error_at = NULL,
           last_error_type = NULL,
           last_error_source = NULL,
           updated_at = ?
     WHERE id = ?
       AND (error_code = 'quota_threshold'
            OR last_error_source = 'quota_rotate'
            OR last_error LIKE '%quota threshold%')
  `);

  const tx = db.transaction((items) => {
    for (const item of items) {
      const { row, meta, entry } = item;
      upsertCache.run(CACHE_NAMESPACE, row.id, JSON.stringify(entry));
      for (const snap of snapshotRows(entry, nowIso)) {
        insertSnapshot.run(
          snap.provider,
          row.id,
          snap.windowKey,
          snap.remaining,
          snap.exhausted,
          snap.resetAt,
          null,
          snap.raw,
          snap.createdAt
        );
      }
      pruneOldSynthetic.run(row.id, iso(nowMs - 48 * 60 * 60 * 1000));
      const nextMeta = {
        ...meta,
        limitTelemetry: {
          source: SOURCE,
          updatedAt: nowIso,
          actualUsageAvailable: false,
          reason: 'token scope user:inference does not expose the quota endpoint',
        },
      };
      updateMeta.run(JSON.stringify(nextMeta), nowIso, row.id);
      if (isOwnQuotaThreshold(row)) clearOwnQuotaBlock.run(nowIso, row.id);
    }
  });

  const items = [];
  for (const row of rows) {
    const meta = safeJson(row.provider_specific_data, {});
    if (!isLongLivedAccessOnly(row, meta)) continue;
    items.push({ row, meta, entry: buildCacheEntry(row, meta, nowMs) });
  }

  if (items.length > 0) tx(items);

  const summary = {
    ok: true,
    updated: items.length,
    source: SOURCE,
    actualUsageAvailable: false,
    note: 'Long-lived access-only Claude tokens can run inference, but cannot expose exact quota telemetry with user:inference scope.',
    connections: items.map((item) => ({ id: item.row.id, name: item.row.name, plan: item.entry.plan })),
  };

  if (!quiet) console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }));
  process.exit(1);
}
