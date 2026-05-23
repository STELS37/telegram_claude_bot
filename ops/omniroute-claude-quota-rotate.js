#!/usr/bin/env node
'use strict';

const fs = require('fs');
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
const QUOTA_STALE_MS = numberEnv('CLAUDE_ROTATE_QUOTA_STALE_MS', 2 * 60 * 60 * 1000);
const QUOTA_VERY_STALE_MS = numberEnv('CLAUDE_ROTATE_QUOTA_VERY_STALE_MS', 24 * 60 * 60 * 1000);
const FRESH_QUOTA_MAX_AGE_MS = numberEnv('CLAUDE_ROTATE_FRESH_QUOTA_MAX_AGE_MS', 90 * 60 * 1000);
const REQUIRE_REAL_QUOTA = boolEnv('CLAUDE_ROTATE_REQUIRE_REAL_QUOTA', true);
const ROUTE_LEASE_DIR = process.env.CLAUDE_ROUTE_LEASE_DIR || '/run/omniroute-claude-route-leases';

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function unlinkQuietly(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

function runnerPidOwnsJob(pid, jobDir) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
  } catch {
    return false;
  }
  try {
    const cmdline = fs.readFileSync('/proc/' + numericPid + '/cmdline', 'utf8').replace(/\0/g, ' ');
    if (!cmdline.includes('claude-runner.js')) return false;
    if (jobDir && !cmdline.includes(String(jobDir))) return false;
    return true;
  } catch {
    return false;
  }
}

function activeRouteLeases() {
  const byConnection = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(ROUTE_LEASE_DIR, { withFileTypes: true });
  } catch {
    return byConnection;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(ROUTE_LEASE_DIR, entry.name);
    const lease = safeReadJson(file);
    if (!lease || lease.provider !== PROVIDER || !lease.connectionId) {
      unlinkQuietly(file);
      continue;
    }
    if (!runnerPidOwnsJob(lease.ownerPid, lease.jobDir)) {
      unlinkQuietly(file);
      continue;
    }
    lease.file = file;
    if (!byConnection.has(lease.connectionId)) byConnection.set(lease.connectionId, []);
    byConnection.get(lease.connectionId).push(lease);
  }
  return byConnection;
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

function quotaAgeFields(observedMs, nowMs, estimated = false) {
  const ageMs = Number.isFinite(observedMs) && observedMs > 0 ? Math.max(0, nowMs - observedMs) : null;
  return {
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    stale: ageMs !== null && ageMs > QUOTA_STALE_MS,
    veryStale: ageMs !== null && ageMs > QUOTA_VERY_STALE_MS,
    estimated: Boolean(estimated),
  };
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

function snapshotMeta(row) {
  const parsed = safeJson(row && row.raw_data);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
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

function inactiveClaudeConnections(db) {
  return db
    .prepare(
      `SELECT id, name, priority, global_priority, rate_limited_until, expires_at,
              access_token IS NOT NULL AS has_access_token,
              refresh_token IS NOT NULL AS has_refresh_token,
              provider_specific_data,
              test_status, error_code, last_error, last_error_at, last_error_type,
              last_error_source, updated_at
         FROM provider_connections
        WHERE provider = ? AND is_active != 1
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
  const meta = snapshotMeta(row);
  const resetMs = parseDateMs(row.next_reset_at);
  const observedMs = parseDateMs(row.created_at) || resetMs || 0;
  const metaFields = {
    providerSource: meta.source || null,
    sourceNote: meta.note || null,
    sourceReason: meta.reason || null,
    actualUsageAvailable: meta.actualUsageAvailable ?? null,
  };
  if (resetMs !== null && resetMs <= nowMs) {
    return {
      remaining: 100,
      used: 0,
      resetAt: null,
      resetMs: null,
      observedMs,
      source: 'snapshot-reset-passed',
      snapshotAt: row.created_at || null,
      ...metaFields,
      ...quotaAgeFields(observedMs, nowMs, true),
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
    ...metaFields,
    ...quotaAgeFields(observedMs, nowMs, false),
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
  const metaFields = {
    providerSource: entry.source || null,
    sourceNote: entry.note || null,
    sourceReason: entry.reason || null,
    actualUsageAvailable: entry.actualUsageAvailable ?? null,
  };
  if (resetMs !== null && resetMs <= nowMs) {
    return {
      remaining: 100,
      used: 0,
      resetAt: null,
      resetMs: null,
      observedMs,
      source: 'cache-reset-passed',
      snapshotAt: entry.fetchedAt || null,
      ...metaFields,
      ...quotaAgeFields(observedMs, nowMs, true),
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
    ...metaFields,
    ...quotaAgeFields(observedMs, nowMs, false),
  };
}

function providerData(conn) {
  return safeJson(conn.provider_specific_data) || {};
}

function inactiveClaudeReason(conn) {
  const code = String(conn.error_code || '').toLowerCase();
  const type = String(conn.last_error_type || '').toLowerCase();
  const source = String(conn.last_error_source || '').toLowerCase();
  const data = providerData(conn);
  const authMethod = data.authMethod || null;
  const accessOnly = authMethod === 'long_lived_access_token' || data.noRefresh === true;
  const hasRefresh = Boolean(conn.has_refresh_token);

  if (code === 'invalid_grant' || type === 'invalid_grant') {
    return 'провайдер отклонил refresh token (invalid_grant); нужен свежий full OAuth импорт';
  }
  if (code === 'invalid_auth_credentials') {
    if (accessOnly || !hasRefresh) {
      return 'Claude Code отклонил access-only credentials (401); нет refresh token и реальных лимитов';
    }
    return 'Claude Code отклонил credentials (401); нужен свежий OAuth импорт';
  }
  if (accessOnly) {
    return 'long-lived access-only token; нет refresh token и реальных лимитов';
  }
  if (!hasRefresh) return 'нет refresh token';
  if (source) return 'отключён в OmniRoute после ошибки ' + source;
  return 'отключён в OmniRoute';
}

function inactiveClaudeAccount(conn) {
  const data = providerData(conn);
  return {
    id: conn.id,
    name: conn.name || conn.id,
    priority: conn.priority,
    globalPriority: conn.global_priority,
    isActive: false,
    testStatus: conn.test_status || null,
    errorCode: conn.error_code || null,
    lastErrorAt: conn.last_error_at || null,
    lastErrorType: conn.last_error_type || null,
    lastErrorSource: conn.last_error_source || null,
    expiresAt: conn.expires_at || null,
    hasAccessToken: Boolean(conn.has_access_token),
    hasRefreshToken: Boolean(conn.has_refresh_token),
    authMethod: data.authMethod || null,
    reason: inactiveClaudeReason(conn),
  };
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
    ageSeconds: null,
    stale: false,
    veryStale: false,
    estimated: true,
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
      ageSeconds: null,
      stale: false,
      veryStale: false,
      estimated: false,
      providerSource: null,
      sourceNote: null,
      sourceReason: null,
      actualUsageAvailable: null,
      real: false,
      realQuotaProblem: 'no quota telemetry',
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
    ageSeconds: picked.ageSeconds ?? null,
    stale: Boolean(picked.stale),
    veryStale: Boolean(picked.veryStale),
    estimated: Boolean(picked.estimated),
    providerSource: picked.providerSource || null,
    sourceNote: picked.sourceNote || null,
    sourceReason: picked.sourceReason || null,
    actualUsageAvailable: picked.actualUsageAvailable ?? null,
    real: false,
    realQuotaProblem: null,
    thresholdRemaining,
    thresholdReached,
  };
}

function quotaSourceText(status) {
  return [
    status && status.source,
    status && status.providerSource,
    status && status.sourceNote,
    status && status.sourceReason,
  ].filter(Boolean).join(' ').toLowerCase();
}

function realQuotaProblem(status) {
  if (!status || status.remaining === null || status.remaining === undefined) return 'no quota value';
  if (status.estimated || String(status.source || '').includes('reset-passed')) return 'estimated from reset time, not measured';
  if (status.source === 'unknown') return 'unknown quota source';
  if (status.source === 'bootstrap') return 'bootstrap quota, not measured';
  if (status.ageSeconds === null || status.ageSeconds === undefined) return 'missing quota timestamp';
  if (status.ageSeconds * 1000 > FRESH_QUOTA_MAX_AGE_MS) return 'quota data is stale';
  if (status.actualUsageAvailable === false) return 'provider says actual usage is unavailable';
  const text = quotaSourceText(status);
  if (/long.?lived|estimated|bootstrap|user:inference|does not expose|no quota telemetry/.test(text)) {
    return 'synthetic quota source';
  }
  return null;
}

function markRealQuota(status) {
  if (!REQUIRE_REAL_QUOTA) {
    status.real = true;
    status.realQuotaProblem = null;
    return status;
  }
  const problem = realQuotaProblem(status);
  status.real = problem === null;
  status.realQuotaProblem = problem;
  return status;
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
    if (status.stale || status.veryStale) continue;
    if (String(status.source || '').includes('reset-passed')) score += 18;
    else if (status.remaining === 100 && status.used === 0) score += 6;
  }
  if (ownQuotaMarker) score += 12;
  return Math.min(36, score);
}

function staleQuotaPenalty(session, weekly) {
  const statuses = [session, weekly];
  if (statuses.some((status) => status.veryStale && status.estimated)) return 35;
  if (statuses.some((status) => status.veryStale)) return 20;
  if (statuses.some((status) => status.stale && status.estimated)) return 12;
  if (statuses.some((status) => status.stale)) return 6;
  return 0;
}

function buildRotationScore(conn, session, weekly, headroomScore, ownQuotaMarker, nowMs) {
  const recencyScore = useRecencyScore(conn, nowMs);
  const resetScore = freshResetScore(session, weekly, ownQuotaMarker);
  const consecutiveUseCount = Number(conn.consecutive_use_count || 0);
  const consecutivePenalty = Math.min(30, consecutiveUseCount * 8);
  const priorityPenalty = Math.max(0, Number(conn.priority || 0)) * 0.03;
  const stalePenalty = staleQuotaPenalty(session, weekly);
  const rotationScore = headroomScore + recencyScore + resetScore - consecutivePenalty - priorityPenalty - stalePenalty;
  return {
    rotationScore: roundPercent(rotationScore),
    recencyScore,
    resetScore,
    consecutivePenalty,
    priorityPenalty: roundPercent(priorityPenalty),
    stalePenalty,
  };
}

function analyzeConnection(conn, snapshots, caches, nowMs, leasesByConnection = new Map()) {
  const connectionSnapshots = snapshots.get(conn.id) || new Map();
  const cacheEntry = caches.get(conn.id) || null;
  const session = markRealQuota(applyBootstrapStatus(conn, pickWindowStatus(connectionSnapshots.get(SESSION_WINDOW), cacheEntry, SESSION_WINDOW, nowMs), SESSION_WINDOW, nowMs));
  const weekly = markRealQuota(applyBootstrapStatus(conn, pickWindowStatus(connectionSnapshots.get(WEEKLY_WINDOW), cacheEntry, WEEKLY_WINDOW, nowMs), WEEKLY_WINDOW, nowMs));

  const ownQuotaMarker = conn.last_error_source === QUOTA_ERROR_SOURCE || conn.error_code === QUOTA_ERROR_CODE;
  const rateLimitedMs = parseDateMs(conn.rate_limited_until);
  const externallyRateLimited = rateLimitedMs !== null && rateLimitedMs > nowMs && !ownQuotaMarker;
  const activeLeases = leasesByConnection.get(conn.id) || [];
  const leaseBlocked = activeLeases.length > 0;

  const reasons = [];
  if (REQUIRE_REAL_QUOTA) {
    for (const status of [session, weekly]) {
      if (!status.real) {
        const label = status.window === SESSION_WINDOW ? 'session' : 'weekly';
        reasons.push(`${label} real quota unavailable: ${status.realQuotaProblem || 'unknown reason'}`);
      }
    }
  }
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
  if (leaseBlocked) {
    reasons.push(`active Claude job lease (${activeLeases.length})`);
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

  const quotaBlocked = !externallyRateLimited && reasons.some((reason) => reason.includes('remaining'));
  const blockUntilMs =
    quotaResetTimes.length > 0 && !externallyRateLimited ? Math.max(...quotaResetTimes) : quotaBlocked ? nowMs + FALLBACK_BLOCK_MS : null;

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
    leaseBlocked,
    activeLeaseCount: activeLeases.length,
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
  const excludedAccounts = inactiveClaudeConnections(db).map(inactiveClaudeAccount);
  const activeLeases = activeRouteLeases();
  const snapshots = latestQuotaSnapshots(db);
  const caches = providerLimitsCache(db);
  const statuses = connections.map((conn) => analyzeConnection(conn, snapshots, caches, nowMs, activeLeases));
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
      requireRealQuota: REQUIRE_REAL_QUOTA,
      freshQuotaMaxAgeMinutes: Math.round(FRESH_QUOTA_MAX_AGE_MS / 60000),
      activeLeaseCount: Array.from(activeLeases.values()).reduce((total, items) => total + items.length, 0),
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
    excludedAccounts,
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
