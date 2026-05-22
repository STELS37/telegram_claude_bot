#!/usr/bin/env node
'use strict';

const path = require('path');

const PROJECT = process.env.OMNIROUTE_PROJECT || '/a0/usr/projects/omniroute';
const DB_PATH = process.env.OMNIROUTE_DB || '/var/lib/omniroute/storage.sqlite';
const PROVIDER = 'claude';
const QUOTA_ERROR_CODE = 'quota_threshold';
const QUOTA_ERROR_SOURCE = 'quota_rotate';
const SESSION_WINDOW = 'session (5h)';
const WEEKLY_WINDOW = 'weekly (7d)';
const DEFAULT_SESSION_MIN_REMAINING = 50;
const DEFAULT_WEEKLY_MIN_REMAINING = 20;
const FALLBACK_BLOCK_MS = 30 * 60 * 1000;
const RECENT_USE_STRONG_PENALTY_MS = numberEnv('CLAUDE_ROTATE_RECENT_STRONG_PENALTY_MS', 5 * 60 * 1000);
const RECENT_USE_PENALTY_MS = numberEnv('CLAUDE_ROTATE_RECENT_PENALTY_MS', 25 * 60 * 1000);
const OLD_USE_BONUS_MS = numberEnv('CLAUDE_ROTATE_OLD_USE_BONUS_MS', 90 * 60 * 1000);
const VERY_OLD_USE_BONUS_MS = numberEnv('CLAUDE_ROTATE_VERY_OLD_USE_BONUS_MS', 4 * 60 * 60 * 1000);
const CONSECUTIVE_WINDOW_MS = numberEnv('CLAUDE_ROTATE_CONSECUTIVE_WINDOW_MS', 30 * 60 * 1000);
const TOKEN_EXPIRY_BUFFER_MS = numberEnv('CLAUDE_ROTATE_TOKEN_EXPIRY_BUFFER_MS', 5 * 60 * 1000);
const LONG_LIVED_RESERVE_SESSION_FLOOR = numberEnv('CLAUDE_ROTATE_LONG_LIVED_RESERVE_SESSION_FLOOR', 65);
const LONG_LIVED_RESERVE_WEEKLY_FLOOR = numberEnv('CLAUDE_ROTATE_LONG_LIVED_RESERVE_WEEKLY_FLOOR', 30);
const LONG_LIVED_RESERVE_MAX_CONSECUTIVE_MEASURED = numberEnv('CLAUDE_ROTATE_LONG_LIVED_RESERVE_MAX_CONSECUTIVE_MEASURED', 3);

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const THRESHOLDS = {
  [SESSION_WINDOW]: numberEnv('CLAUDE_ROTATE_SESSION_MIN_REMAINING', DEFAULT_SESSION_MIN_REMAINING),
  [WEEKLY_WINDOW]: numberEnv('CLAUDE_ROTATE_WEEKLY_MIN_REMAINING', DEFAULT_WEEKLY_MIN_REMAINING),
};

function loadDb() {
  const Database = require(path.join(PROJECT, 'node_modules/better-sqlite3'));
  return new Database(DB_PATH);
}

function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

function parseDateMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function roundPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function activeClaudeConnections(db) {
  return db
    .prepare(
      `SELECT id, name, priority, global_priority, rate_limited_until, expires_at,
              access_token IS NOT NULL AS has_access_token,
              refresh_token IS NOT NULL AS has_refresh_token,
              provider_specific_data,
              last_error_source, error_code, last_used_at, consecutive_use_count, updated_at
         FROM provider_connections
        WHERE provider = ? AND is_active = 1
        ORDER BY priority ASC, updated_at DESC`
    )
    .all(PROVIDER);
}

function latestQuotaSnapshots(db) {
  const rows = db
    .prepare(
      `SELECT *
         FROM (
           SELECT qs.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY qs.connection_id, qs.window_key
                    ORDER BY qs.created_at DESC, qs.id DESC
                  ) AS rn
             FROM quota_snapshots qs
            WHERE qs.provider = ?
              AND qs.window_key IN (?, ?)
         )
        WHERE rn = 1`
    )
    .all(PROVIDER, SESSION_WINDOW, WEEKLY_WINDOW);

  const byConnection = new Map();
  for (const row of rows) {
    if (!byConnection.has(row.connection_id)) byConnection.set(row.connection_id, new Map());
    byConnection.get(row.connection_id).set(row.window_key, row);
  }
  return byConnection;
}

function providerLimitsCache(db) {
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all('providerLimitsCache');
  const out = new Map();
  for (const row of rows) {
    const parsed = safeJson(row.value);
    if (parsed && typeof parsed === 'object') out.set(row.key, parsed);
  }
  return out;
}

function remainingFromQuota(quota) {
  if (!quota || typeof quota !== 'object') return null;
  if (quota.remainingPercentage != null) return clampPercent(quota.remainingPercentage);
  if (quota.remaining_percentage != null) return clampPercent(quota.remaining_percentage);
  const total = Number(quota.total);
  const remaining = Number(quota.remaining);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(remaining)) {
    return clampPercent((remaining / total) * 100);
  }
  const used = Number(quota.used);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) {
    return clampPercent(100 - (used / total) * 100);
  }
  return null;
}

function candidateFromSnapshot(row, nowMs) {
  if (!row) return null;
  const resetMs = parseDateMs(row.next_reset_at);
  const observedMs = parseDateMs(row.created_at) || resetMs || 0;
  if (resetMs !== null && resetMs <= nowMs) {
    return {
      remaining: 100,
      used: 0,
      resetAt: null,
      resetMs: null,
      observedMs,
      source: 'snapshot-reset-passed',
      snapshotAt: row.created_at || null,
    };
  }
  const remaining = clampPercent(row.remaining_percentage);
  if (remaining === null) return null;
  return {
    remaining,
    used: 100 - remaining,
    resetAt: row.next_reset_at || null,
    resetMs,
    observedMs,
    source: 'snapshot',
    snapshotAt: row.created_at || null,
  };
}

function candidateFromCache(entry, windowKey, nowMs) {
  if (!entry || typeof entry !== 'object') return null;
  const quotas = entry.quotas && typeof entry.quotas === 'object' ? entry.quotas : null;
  if (!quotas) return null;
  const quota = quotas[windowKey];
  const remaining = remainingFromQuota(quota);
  if (remaining === null) return null;
  const resetAt = quota && typeof quota === 'object' ? quota.resetAt || quota.nextResetAt || quota.next_reset_at || null : null;
  const resetMs = parseDateMs(resetAt);
  const observedMs = parseDateMs(entry.fetchedAt) || resetMs || 0;
  if (resetMs !== null && resetMs <= nowMs) {
    return {
      remaining: 100,
      used: 0,
      resetAt: null,
      resetMs: null,
      observedMs,
      source: 'cache-reset-passed',
      snapshotAt: entry.fetchedAt || null,
    };
  }
  return {
    remaining,
    used: 100 - remaining,
    resetAt: resetAt || null,
    resetMs,
    observedMs,
    source: 'cache',
    snapshotAt: entry.fetchedAt || null,
  };
}

function providerData(conn) {
  return safeJson(conn.provider_specific_data) || {};
}

function isLongLivedAccessOnly(conn) {
  const data = providerData(conn);
  return data.authMethod === 'long_lived_access_token' || data.noRefresh === true;
}

function bootstrapRemaining(conn, windowKey, nowMs) {
  const data = providerData(conn);
  const untilMs = parseDateMs(data.bootstrapQuotaUntil);
  if (untilMs !== null && untilMs <= nowMs) return null;
  const byWindow = data.bootstrapQuotaRemaining && typeof data.bootstrapQuotaRemaining === 'object' ? data.bootstrapQuotaRemaining : null;
  if (byWindow && byWindow[windowKey] != null) return clampPercent(byWindow[windowKey]);
  if (data.bootstrapQuotaRemainingPercentage != null) return clampPercent(data.bootstrapQuotaRemainingPercentage);
  return null;
}

function applyBootstrapStatus(conn, status, windowKey, nowMs) {
  if (!status || status.remaining !== null) return status;
  const remaining = bootstrapRemaining(conn, windowKey, nowMs);
  if (remaining === null) return status;
  const thresholdRemaining = THRESHOLDS[windowKey];
  return {
    ...status,
    remaining: roundPercent(remaining),
    used: roundPercent(100 - remaining),
    source: 'bootstrap',
    snapshotAt: null,
    thresholdReached: thresholdRemaining !== null && remaining < thresholdRemaining,
  };
}

function pickWindowStatus(snapshotRow, cacheEntry, windowKey, nowMs) {
  const candidates = [
    candidateFromSnapshot(snapshotRow, nowMs),
    candidateFromCache(cacheEntry, windowKey, nowMs),
  ].filter(Boolean);

  if (candidates.length === 0) {
    return {
      window: windowKey,
      remaining: null,
      used: null,
      resetAt: null,
      source: 'unknown',
      snapshotAt: null,
      thresholdRemaining: THRESHOLDS[windowKey],
      thresholdReached: false,
    };
  }

  candidates.sort((a, b) => b.observedMs - a.observedMs);
  const picked = candidates[0];
  const thresholdRemaining = THRESHOLDS[windowKey];
  const thresholdReached =
    picked.remaining !== null &&
    thresholdRemaining !== null &&
    picked.remaining < thresholdRemaining &&
    !(picked.resetMs !== null && picked.resetMs <= nowMs);

  return {
    window: windowKey,
    remaining: roundPercent(picked.remaining),
    used: roundPercent(picked.used),
    resetAt: picked.resetAt,
    source: picked.source,
    snapshotAt: picked.snapshotAt,
    thresholdRemaining,
    thresholdReached,
  };
}

function lastUsedAgeMs(conn, nowMs) {
  const lastUsedMs = parseDateMs(conn.last_used_at);
  if (lastUsedMs === null) return null;
  return Math.max(0, nowMs - lastUsedMs);
}

function useRecencyScore(conn, nowMs) {
  const age = lastUsedAgeMs(conn, nowMs);
  if (age === null) return 18;
  if (age < RECENT_USE_STRONG_PENALTY_MS) return -30;
  if (age < RECENT_USE_PENALTY_MS) return -14;
  if (age >= VERY_OLD_USE_BONUS_MS) return 12;
  if (age >= OLD_USE_BONUS_MS) return 6;
  return 0;
}

function freshResetScore(session, weekly, ownQuotaMarker) {
  let score = 0;
  for (const status of [session, weekly]) {
    if (String(status.source || '').includes('reset-passed')) score += 18;
    else if (status.remaining === 100 && status.used === 0) score += 6;
  }
  if (ownQuotaMarker) score += 12;
  return Math.min(36, score);
}

function buildRotationScore(conn, session, weekly, headroomScore, ownQuotaMarker, nowMs) {
  const recencyScore = useRecencyScore(conn, nowMs);
  const resetScore = freshResetScore(session, weekly, ownQuotaMarker);
  const consecutiveUseCount = Number(conn.consecutive_use_count || 0);
  const consecutivePenalty = Math.min(30, consecutiveUseCount * 8);
  const priorityPenalty = Math.max(0, Number(conn.priority || 0)) * 0.03;
  const rotationScore = headroomScore + recencyScore + resetScore - consecutivePenalty - priorityPenalty;
  return {
    rotationScore: roundPercent(rotationScore),
    recencyScore,
    resetScore,
    consecutivePenalty,
    priorityPenalty: roundPercent(priorityPenalty),
  };
}

function analyzeConnection(conn, snapshots, caches, nowMs) {
  const connectionSnapshots = snapshots.get(conn.id) || new Map();
  const cacheEntry = caches.get(conn.id) || null;
  const session = applyBootstrapStatus(conn, pickWindowStatus(connectionSnapshots.get(SESSION_WINDOW), cacheEntry, SESSION_WINDOW, nowMs), SESSION_WINDOW, nowMs);
  const weekly = applyBootstrapStatus(conn, pickWindowStatus(connectionSnapshots.get(WEEKLY_WINDOW), cacheEntry, WEEKLY_WINDOW, nowMs), WEEKLY_WINDOW, nowMs);

  const ownQuotaMarker = conn.last_error_source === QUOTA_ERROR_SOURCE || conn.error_code === QUOTA_ERROR_CODE;
  const rateLimitedMs = parseDateMs(conn.rate_limited_until);
  const externallyRateLimited = rateLimitedMs !== null && rateLimitedMs > nowMs && !ownQuotaMarker;

  const reasons = [];
  const quotaResetTimes = [];
  for (const status of [session, weekly]) {
    if (!status.thresholdReached) continue;
    const label = status.window === SESSION_WINDOW ? 'session' : 'weekly';
    reasons.push(
      `${label} remaining ${status.remaining}% < ${status.thresholdRemaining}%`
    );
    const resetMs = parseDateMs(status.resetAt);
    if (resetMs !== null && resetMs > nowMs) quotaResetTimes.push(resetMs);
  }
  if (externallyRateLimited) {
    reasons.push(`external rate limit until ${conn.rate_limited_until}`);
  }
  const tokenExpiresMs = parseDateMs(conn.expires_at);
  if (!conn.has_access_token) {
    reasons.push('missing access token');
  }
  if (!conn.has_refresh_token && !isLongLivedAccessOnly(conn)) {
    reasons.push('missing refresh token');
  }
  if (tokenExpiresMs !== null && tokenExpiresMs <= nowMs + TOKEN_EXPIRY_BUFFER_MS) {
    reasons.push(`token expires at ${conn.expires_at}`);
  }

  const quotaBlocked = reasons.some((reason) => reason.includes('remaining'));
  const blockUntilMs =
    quotaResetTimes.length > 0 ? Math.max(...quotaResetTimes) : quotaBlocked ? nowMs + FALLBACK_BLOCK_MS : null;

  const sessionScore = session.remaining === null ? 0 : session.remaining;
  const weeklyScore = weekly.remaining === null ? 0 : weekly.remaining;
  const score = Math.min(sessionScore, weeklyScore);
  const rotation = buildRotationScore(conn, session, weekly, score, ownQuotaMarker && !quotaBlocked, nowMs);

  return {
    id: conn.id,
    name: conn.name || conn.id,
    currentPriority: conn.priority,
    newPriority: conn.priority,
    score,
    rotationScore: rotation.rotationScore,
    rotation,
    lastUsedAt: conn.last_used_at || null,
    lastUsedAgeSeconds: lastUsedAgeMs(conn, nowMs) === null ? null : Math.round(lastUsedAgeMs(conn, nowMs) / 1000),
    consecutiveUseCount: Number(conn.consecutive_use_count || 0),
    eligible: reasons.length === 0,
    quotaBlocked,
    externallyRateLimited,
    blockUntil: blockUntilMs === null ? null : iso(blockUntilMs),
    ownQuotaMarker,
    authMethod: isLongLivedAccessOnly(conn) ? 'long_lived_access_token' : 'oauth_refresh',
    expiresAt: conn.expires_at || null,
    reasons,
    session,
    weekly,
  };
}

function isStrongMeasuredEligible(item) {
  if (!item.eligible || item.authMethod === 'long_lived_access_token') return false;
  const sessionRemaining = Number(item.session && item.session.remaining);
  const weeklyRemaining = Number(item.weekly && item.weekly.remaining);
  const consecutiveUseCount = Number(item.consecutiveUseCount || 0);
  return (
    Number.isFinite(sessionRemaining) &&
    Number.isFinite(weeklyRemaining) &&
    sessionRemaining >= LONG_LIVED_RESERVE_SESSION_FLOOR &&
    weeklyRemaining >= LONG_LIVED_RESERVE_WEEKLY_FLOOR &&
    consecutiveUseCount < LONG_LIVED_RESERVE_MAX_CONSECUTIVE_MEASURED
  );
}

function hasStrongMeasuredEligible(statuses) {
  return statuses.some(isStrongMeasuredEligible);
}

function eligibilityTier(item, statuses) {
  if (item.authMethod !== 'long_lived_access_token') return 0;
  return hasStrongMeasuredEligible(statuses) ? 1 : 0;
}

function buildPriorityPlan(statuses) {
  const eligible = statuses
    .filter((item) => item.eligible)
    .sort((a, b) =>
      eligibilityTier(a, statuses) - eligibilityTier(b, statuses) ||
      b.rotationScore - a.rotationScore ||
      b.score - a.score ||
      (a.lastUsedAgeSeconds ?? Number.MAX_SAFE_INTEGER) - (b.lastUsedAgeSeconds ?? Number.MAX_SAFE_INTEGER) ||
      a.currentPriority - b.currentPriority ||
      a.name.localeCompare(b.name)
    );
  const blocked = statuses
    .filter((item) => !item.eligible)
    .sort((a, b) => a.currentPriority - b.currentPriority || a.name.localeCompare(b.name));

  let priority = 1;
  for (const item of eligible) item.newPriority = priority++;
  priority = Math.max(priority, 50);
  for (const item of blocked) item.newPriority = priority++;

  return eligible[0] || null;
}

function applyPlan(db, statuses, nowMs) {
  const updateQuotaBlocked = db.prepare(
    `UPDATE provider_connections
        SET priority = ?,
            rate_limited_until = ?,
            error_code = ?,
            last_error = ?,
            last_error_at = ?,
            last_error_type = ?,
            last_error_source = ?,
            updated_at = ?
      WHERE id = ?`
  );
  const updateClearOwnBlock = db.prepare(
    `UPDATE provider_connections
        SET priority = ?,
            rate_limited_until = NULL,
            error_code = NULL,
            last_error = NULL,
            last_error_at = NULL,
            last_error_type = NULL,
            last_error_source = NULL,
            updated_at = ?
      WHERE id = ?`
  );
  const updatePriorityOnly = db.prepare(
    `UPDATE provider_connections
        SET priority = ?,
            updated_at = ?
      WHERE id = ?`
  );

  const tx = db.transaction((items) => {
    const nowIso = iso(nowMs);
    for (const item of items) {
      if (item.quotaBlocked) {
        updateQuotaBlocked.run(
          item.newPriority,
          item.blockUntil,
          QUOTA_ERROR_CODE,
          `Claude quota threshold reached: ${item.reasons.join('; ')}`,
          nowIso,
          'quota_policy',
          QUOTA_ERROR_SOURCE,
          nowIso,
          item.id
        );
        continue;
      }

      if (item.ownQuotaMarker) {
        updateClearOwnBlock.run(item.newPriority, nowIso, item.id);
        continue;
      }

      updatePriorityOnly.run(item.newPriority, nowIso, item.id);
    }
  });
  tx(statuses);
}

function recordClaudeConnectionUse(db, connectionId, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const nowIso = iso(nowMs);
  const row = db.prepare(
    `SELECT last_used_at, consecutive_use_count FROM provider_connections WHERE id = ? AND provider = ?`
  ).get(connectionId, PROVIDER);
  if (!row) return null;
  const previousLastUsedMs = parseDateMs(row.last_used_at);
  const wasRecent = previousLastUsedMs !== null && nowMs - previousLastUsedMs < CONSECUTIVE_WINDOW_MS;
  const consecutiveUseCount = wasRecent ? Number(row.consecutive_use_count || 0) + 1 : 1;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE provider_connections
          SET last_used_at = ?,
              consecutive_use_count = ?,
              updated_at = ?
        WHERE id = ? AND provider = ?`
    ).run(nowIso, consecutiveUseCount, nowIso, connectionId, PROVIDER);
    db.prepare(
      `UPDATE provider_connections
          SET consecutive_use_count = 0
        WHERE provider = ? AND id <> ? AND consecutive_use_count != 0`
    ).run(PROVIDER, connectionId);
  });
  tx();
  return { connectionId, lastUsedAt: nowIso, consecutiveUseCount };
}

function rotateClaudeConnections(db, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const connections = activeClaudeConnections(db);
  const snapshots = latestQuotaSnapshots(db);
  const caches = providerLimitsCache(db);
  const statuses = connections.map((conn) => analyzeConnection(conn, snapshots, caches, nowMs));
  const selected = buildPriorityPlan(statuses);

  if (options.apply !== false) {
    applyPlan(db, statuses, nowMs);
  }

  return {
    ok: true,
    provider: PROVIDER,
    thresholds: {
      sessionMinRemaining: THRESHOLDS[SESSION_WINDOW],
      weeklyMinRemaining: THRESHOLDS[WEEKLY_WINDOW],
      sessionMaxUsed: 100 - THRESHOLDS[SESSION_WINDOW],
      weeklyMaxUsed: 100 - THRESHOLDS[WEEKLY_WINDOW],
      longLivedReserveSessionFloor: LONG_LIVED_RESERVE_SESSION_FLOOR,
      longLivedReserveWeeklyFloor: LONG_LIVED_RESERVE_WEEKLY_FLOOR,
      longLivedReserveMaxConsecutiveMeasured: LONG_LIVED_RESERVE_MAX_CONSECUTIVE_MEASURED,
    },
    selected: selected
      ? {
          id: selected.id,
          name: selected.name,
          score: selected.score,
          rotationScore: selected.rotationScore,
          priority: selected.newPriority,
          lastUsedAt: selected.lastUsedAt,
          consecutiveUseCount: selected.consecutiveUseCount,
        }
      : null,
    accounts: statuses,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const quiet = process.argv.includes('--quiet');
  const selectId = process.argv.includes('--select-id');
  const db = loadDb();
  try {
    const result = rotateClaudeConnections(db, { apply: !dryRun });
    if (selectId) {
      if (result.selected) process.stdout.write(result.selected.id + '\n');
      process.exit(result.selected ? 0 : 2);
    }
    if (!quiet) console.log(JSON.stringify(result, null, 2));
    process.exit(result.selected ? 0 : 2);
  } finally {
    db.close();
  }
}

module.exports = {
  rotateClaudeConnections,
  recordClaudeConnectionUse,
  loadDb,
  constants: {
    PROVIDER,
    SESSION_WINDOW,
    WEEKLY_WINDOW,
    THRESHOLDS,
    QUOTA_ERROR_CODE,
    QUOTA_ERROR_SOURCE,
  },
};
