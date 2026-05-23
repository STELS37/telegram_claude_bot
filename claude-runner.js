const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const jobDir = process.argv[2] ? path.resolve(process.argv[2]) : '';
const configPath = process.argv[3] ? path.resolve(process.argv[3]) : '';

if (!jobDir || !configPath) {
    console.error('Usage: node claude-runner.js <jobDir> <configPath>');
    process.exit(2);
}

const jobFile = path.join(jobDir, 'job.json');
const stateFile = path.join(jobDir, 'state.json');
const eventsFile = path.join(jobDir, 'events.jsonl');
const stderrFile = path.join(jobDir, 'stderr.log');
const OFFICIAL_CLAUDE_PATH = '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const OAUTH_SYNC_PATH = '/usr/local/sbin/sync-omniroute-claude-code-oauth.js';
const OAUTH_IMPORT_PATH = '/usr/local/sbin/import-claude-code-oauth-to-omniroute.js';
const ROOT_CLAUDE_DIR = '/root/.claude';
const RUNTIME_ENV_PATH = path.join(ROOT_CLAUDE_DIR, '.omniroute-runtime-env.json');
const OMNIROUTE_PROJECT = '/a0/usr/projects/omniroute';
const OMNIROUTE_DB_PATH = '/var/lib/omniroute/storage.sqlite';
const FULL_ACCESS_TOOLS = [
    'Bash(*)',
    'Read(*)',
    'Write(*)',
    'Edit(*)',
    'MultiEdit(*)',
    'Glob(*)',
    'Grep(*)',
    'LS(*)',
    'TodoWrite(*)',
    'Task(*)',
    'WebFetch(*)',
    'WebSearch(*)',
    'NotebookRead(*)',
    'NotebookEdit(*)'
];

function readJson(file, fallback = {}) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}

function writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

function mergeState(patch) {
    const current = readJson(stateFile, {});
    writeJsonAtomic(stateFile, {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString()
    });
}

function appendEvent(event) {
    fs.appendFileSync(eventsFile, JSON.stringify({
        runner_ts: new Date().toISOString(),
        ...event
    }) + '\n');
}

function tailText(text, max = 12000) {
    text = String(text || '');
    return text.length > max ? text.slice(-max) : text;
}

function redactSensitiveText(text) {
    return String(text || '')
        .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-token]')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted-token]')
        .replace(/((?:access|refresh)[_-]?token["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[redacted-token]');
}

function isClaudeMonthlyUsageLimit(text) {
    const value = String(text || '').toLowerCase();
    return value.includes('monthly usage limit')
        || value.includes("org's monthly")
        || value.includes('org monthly');
}

function nextMonthStartIso(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString();
}

function markClaudeMonthlyUsageLimit(home, errorText) {
    if (!isClaudeMonthlyUsageLimit(errorText)) return null;

    const baseHome = home || '/root';
    const syncPath = path.basename(baseHome) === '.claude'
        ? path.join(baseHome, '.omniroute-sync.json')
        : path.join(baseHome, '.claude', '.omniroute-sync.json');
    const sync = readJson(syncPath, null);
    if (!sync || !sync.connectionId) {
        return { ok: false, reason: 'omniroute sync metadata missing' };
    }

    try {
        const Database = require(path.join(OMNIROUTE_PROJECT, 'node_modules/better-sqlite3'));
        const db = new Database(OMNIROUTE_DB_PATH);
        try {
            const nowIso = new Date().toISOString();
            const blockUntil = nextMonthStartIso();
            const info = db.prepare(
                `UPDATE provider_connections
                    SET rate_limited_until = ?,
                        error_code = ?,
                        last_error = ?,
                        last_error_at = ?,
                        last_error_type = ?,
                        last_error_source = ?,
                        priority = CASE WHEN priority < 80 THEN 80 ELSE priority END,
                        updated_at = ?
                  WHERE provider = 'claude'
                    AND id = ?`
            ).run(
                blockUntil,
                'monthly_usage_limit',
                'Claude Code reported org monthly usage limit',
                nowIso,
                'rate_limit',
                'claude_code_cli',
                nowIso,
                sync.connectionId
            );
            return {
                ok: info.changes > 0,
                connectionId: sync.connectionId,
                connectionName: sync.connectionName || null,
                blockUntil
            };
        } finally {
            db.close();
        }
    } catch (err) {
        return { ok: false, connectionId: sync.connectionId, error: err.message };
    }
}

function isClaudeAuthCredentialError(text) {
    const value = String(text || '').toLowerCase();
    return value.includes('invalid authentication credentials')
        || value.includes('failed to authenticate')
        || value.includes('not logged in');
}

function markClaudeAuthCredentialRoute(home, errorText) {
    if (!isClaudeAuthCredentialError(errorText)) return null;

    const baseHome = home || '/root';
    const syncPath = path.basename(baseHome) === '.claude'
        ? path.join(baseHome, '.omniroute-sync.json')
        : path.join(baseHome, '.claude', '.omniroute-sync.json');
    const sync = readJson(syncPath, null);
    if (!sync || !sync.connectionId) {
        return { ok: false, reason: 'omniroute sync metadata missing' };
    }

    try {
        const Database = require(path.join(OMNIROUTE_PROJECT, 'node_modules/better-sqlite3'));
        const db = new Database(OMNIROUTE_DB_PATH);
        try {
            const now = new Date();
            const nowIso = now.toISOString();
            const blockUntil = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
            const row = db.prepare(
                `SELECT refresh_token, provider_specific_data
                   FROM provider_connections
                  WHERE provider = 'claude' AND id = ?`
            ).get(sync.connectionId) || {};
            let providerData = {};
            try { providerData = row.provider_specific_data ? JSON.parse(row.provider_specific_data) : {}; } catch {}
            const accessOnly = providerData.authMethod === 'long_lived_access_token'
                || providerData.noRefresh === true
                || !row.refresh_token
                || sync.authMethod === 'long_lived_access_token';
            const sql = accessOnly
                ? `UPDATE provider_connections
                    SET is_active = 0,
                        rate_limited_until = NULL,
                        test_status = 'expired',
                        error_code = ?,
                        last_error = ?,
                        last_error_at = ?,
                        last_error_type = ?,
                        last_error_source = ?,
                        priority = CASE WHEN priority < 99 THEN 99 ELSE priority END,
                        updated_at = ?
                  WHERE provider = 'claude'
                    AND id = ?`
                : `UPDATE provider_connections
                    SET rate_limited_until = ?,
                        error_code = ?,
                        last_error = ?,
                        last_error_at = ?,
                        last_error_type = ?,
                        last_error_source = ?,
                        priority = CASE WHEN priority < 90 THEN 90 ELSE priority END,
                        updated_at = ?
                  WHERE provider = 'claude'
                    AND id = ?`;
            const params = accessOnly
                ? [
                    'invalid_auth_credentials',
                    'Claude Code reported invalid authentication credentials for access-only token; disabled until reimport',
                    nowIso,
                    'auth',
                    'claude_code_cli_auth',
                    nowIso,
                    sync.connectionId
                ]
                : [
                    blockUntil,
                    'invalid_auth_credentials',
                    'Claude Code reported invalid authentication credentials',
                    nowIso,
                    'auth',
                    'claude_code_cli_auth',
                    nowIso,
                    sync.connectionId
                ];
            const info = db.prepare(sql).run(...params);
            return {
                ok: info.changes > 0,
                connectionId: sync.connectionId,
                connectionName: sync.connectionName || null,
                accessOnlyDisabled: accessOnly,
                blockUntil: accessOnly ? null : blockUntil
            };
        } finally {
            db.close();
        }
    } catch (err) {
        return { ok: false, connectionId: sync.connectionId, error: err.message };
    }
}

function forceRefreshClaudeOAuthAfterAuthError(errorText) {
    if (!isClaudeAuthCredentialError(errorText)) return null;
    if (!fs.existsSync(OAUTH_SYNC_PATH)) return { ok: false, reason: 'oauth sync script missing' };

    try {
        return withFileLock('/tmp/claude-oauth-sync.lock', () => {
            const sync = spawnSync(process.execPath, [OAUTH_SYNC_PATH, '--force', '--quiet'], {
                cwd: '/root',
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 60 * 1000
            });
            const stdout = sync.stdout ? sync.stdout.toString('utf8') : '';
            const stderr = sync.stderr ? sync.stderr.toString('utf8') : '';
            return {
                ok: !sync.error && sync.status === 0,
                status: sync.status,
                error: sync.error ? sync.error.message : null,
                stdoutTail: redactSensitiveText(tailText(stdout, 1000)),
                stderrTail: redactSensitiveText(tailText(stderr, 1000))
            };
        });
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

function formatMoscowTime(isoValue) {
    if (!isoValue) return null;
    const date = new Date(isoValue);
    if (!Number.isFinite(date.getTime())) return null;
    try {
        return new Intl.DateTimeFormat('ru-RU', {
            timeZone: 'Europe/Moscow',
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(date) + ' МСК';
    } catch {
        return isoValue;
    }
}

function formatDurationRu(ms) {
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'сейчас';
    const minutes = Math.ceil(ms / 60000);
    if (minutes < 60) return 'через ' + minutes + ' мин';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return 'через ' + hours + ' ч' + (rest ? ' ' + rest + ' мин' : '');
    const days = Math.floor(hours / 24);
    const dayHours = hours % 24;
    return 'через ' + days + ' д' + (dayHours ? ' ' + dayHours + ' ч' : '');
}

function formatFutureMoscowTime(isoValue) {
    const formatted = formatMoscowTime(isoValue);
    if (!formatted) return null;
    const ms = new Date(isoValue).getTime();
    const rel = formatDurationRu(ms - Date.now());
    return rel ? formatted + ' (' + rel + ')' : formatted;
}

function percentText(value) {
    return value === null || value === undefined ? '?' : String(value);
}

function quotaWindowLabel(windowKey) {
    const text = String(windowKey || '').toLowerCase();
    if (text.includes('5h') || text.includes('session')) return '5ч';
    if (text.includes('7d') || text.includes('weekly')) return '7д';
    return windowKey || 'лимит';
}

function windowLine(status) {
    const label = quotaWindowLabel(status && status.window);
    const remaining = percentText(status && status.remaining);
    const threshold = percentText(status && status.thresholdRemaining);
    const ok = status && !status.thresholdReached;
    return label + ': ' + remaining + '% / минимум ' + threshold + '%' + (ok ? ' - ок' : ' - ниже резерва');
}

function snapshotAgeText(snapshotAt) {
    if (!snapshotAt) return '';
    const ms = Date.now() - new Date(snapshotAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const age = formatDurationRu(ms).replace(/^через /, '');
    const suffix = ms > 20 * 60 * 1000 ? ' (данные старые)' : '';
    return 'обновлено ' + age + ' назад' + suffix;
}

function blockingWindows(account) {
    return [account && account.session, account && account.weekly]
        .filter((status) => status && status.thresholdReached);
}

function externalBlockIso(account) {
    if (!account || !account.externallyRateLimited) return null;
    const reasons = Array.isArray(account.reasons) ? account.reasons : [];
    for (const reason of reasons) {
        const match = String(reason || '').match(/until\s+([^\s]+)$/i);
        if (match && Number.isFinite(new Date(match[1]).getTime())) return match[1];
    }
    return account.blockUntil || null;
}

function availabilityFromBlockingWindows(account) {
    const externalIso = externalBlockIso(account);
    if (externalIso) return { iso: externalIso, source: 'auth/cooldown' };
    const blockers = blockingWindows(account);
    const resetTimes = blockers
        .map((status) => ({ status, ms: status.resetAt ? new Date(status.resetAt).getTime() : null }))
        .filter((item) => Number.isFinite(item.ms) && item.ms > Date.now())
        .sort((a, b) => b.ms - a.ms);
    if (resetTimes.length > 0) return { iso: resetTimes[0].status.resetAt, source: quotaWindowLabel(resetTimes[0].status.window) + ' resetAt' };
    if (account && account.blockUntil) return { iso: account.blockUntil, source: 'внутренняя блокировка OmniRoute' };
    return { iso: null, source: null };
}

function shortAccountName(account) {
    const name = account && account.name ? String(account.name) : '';
    if (name && name !== account.id) return name;
    const id = account && account.id ? String(account.id) : '';
    return id ? 'Без названия (' + id.slice(0, 8) + ')' : 'Claude account';
}

function quotaStatusText(status) {
    const remaining = percentText(status && status.remaining);
    const threshold = percentText(status && status.thresholdRemaining);
    return remaining + '% (нужно ' + threshold + '%+)';
}

function availabilityLine(account) {
    const availability = availabilityFromBlockingWindows(account);
    const availableAt = formatFutureMoscowTime(availability.iso);
    if (!availableAt) return 'после обновления лимитов';
    if (availability.source === 'auth/cooldown') return 'после проверки авторизации: ' + availableAt;
    return availableAt;
}

function readableNonQuotaReason(reason) {
    const text = String(reason || '');
    if (/external rate limit until/i.test(text)) return 'маршрут временно заблокирован после ошибки авторизации';
    if (/token expires at/i.test(text)) return 'OAuth-токен истёк или требует refresh';
    if (/missing refresh token/i.test(text)) return 'нет refresh token';
    if (/missing access token/i.test(text)) return 'нет access token';
    return text;
}

function blockerText(account) {
    const blockers = blockingWindows(account);
    const parts = blockers.map((status) => {
        const label = quotaWindowLabel(status.window) === '5ч' ? '5 часов' : '7 дней';
        return label + ': ' + quotaStatusText(status);
    });
    const reasons = Array.isArray(account && account.reasons) ? account.reasons : [];
    for (const reason of reasons) {
        if (/remaining\s+\d/i.test(String(reason || ''))) continue;
        const readable = readableNonQuotaReason(reason);
        if (readable && !parts.includes(readable)) parts.push(readable);
    }
    return parts.length ? parts.join('; ') : 'нет точной причины, нужен refresh лимитов';
}

function freshnessText(account) {
    const blockers = blockingWindows(account);
    const ages = blockers.map((status) => snapshotAgeText(status.snapshotAt)).filter(Boolean);
    if (!ages.length) return '';
    return 'Данные: ' + ages.join(', ') + '.';
}

function accountReserveLine(account) {
    return '5ч ' + percentText(account.session && account.session.remaining) + '%, 7д ' + percentText(account.weekly && account.weekly.remaining) + '%';
}

function hasStaleQuotaData(account) {
    return [account && account.session, account && account.weekly].some((status) => {
        const ms = Date.now() - new Date(status && status.snapshotAt || 0).getTime();
        return Number.isFinite(ms) && ms > 20 * 60 * 1000;
    });
}

function buildAccountLine(account, index) {
    const stale = hasStaleQuotaData(account);
    return [
        String(index + 1) + '. ' + shortAccountName(account) + ' — ' + availabilityLine(account),
        '   Остаток: ' + accountReserveLine(account) + '.',
        '   Не проходит: ' + blockerText(account) + '.',
        stale ? '   Данные лимитов старые; причина блокировки может быть не в лимитах.' : null
    ].filter(Boolean).join('\n');
}

function buildOmniRouteQuotaStatusMessage() {
    const rotatorPath = '/usr/local/sbin/omniroute-claude-quota-rotate.js';
    if (!fs.existsSync(rotatorPath)) return '';
    const dryRun = spawnSync(process.execPath, [rotatorPath, '--dry-run'], {
        cwd: '/a0/usr/projects/omniroute',
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60 * 1000
    });
    const raw = redactSensitiveText([
        dryRun.stdout ? dryRun.stdout.toString('utf8') : '',
        dryRun.stderr ? dryRun.stderr.toString('utf8') : ''
    ].join('\n')).trim();
    if (!raw) return '';

    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch {
        for (const line of raw.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
            try { parsed = JSON.parse(line); break; } catch {}
        }
    }
    if (!parsed || !Array.isArray(parsed.accounts)) return '';

    const thresholds = parsed.thresholds || {};
    const accounts = parsed.accounts
        .slice()
        .sort((a, b) => {
            const aa = availabilityFromBlockingWindows(a).iso;
            const bb = availabilityFromBlockingWindows(b).iso;
            const at = aa ? new Date(aa).getTime() : Number.MAX_SAFE_INTEGER;
            const bt = bb ? new Date(bb).getTime() : Number.MAX_SAFE_INTEGER;
            if (Math.abs(at - bt) > 5 * 60 * 1000) return at - bt;
            return (b.score || 0) - (a.score || 0);
        });

    const next = accounts[0] || null;
    const nextAvailability = next ? availabilityFromBlockingWindows(next) : null;
    const nextIsAuthCooldown = nextAvailability && nextAvailability.source === 'auth/cooldown';
    const nextLines = next
        ? [
            nextIsAuthCooldown ? 'Ближайшая повторная проверка Claude-маршрута:' : 'Ближайший запуск Opus 4.7:',
            shortAccountName(next) + ' — ' + availabilityLine(next) + '.',
            'Сейчас: ' + accountReserveLine(next) + '. ' + (nextIsAuthCooldown ? 'Причина блокировки: ' : 'Не хватает: ') + blockerText(next) + '.'
        ]
        : ['Ближайший запуск Opus 4.7: нет данных.'];

    return [
        'Сейчас Opus 4.7 запускать нельзя: нет Claude-маршрута выше резервов и без блокировок.',
        '',
        ...nextLines,
        '',
        'Правило резерва: 5ч >= ' + (thresholds.sessionMinRemaining ?? 50) + '%, 7д >= ' + (thresholds.weeklyMinRemaining ?? 20) + '%.',
        '',
        'Все аккаунты (' + accounts.length + '):',
        ...accounts.map(buildAccountLine)
    ].join('\n');
}

function summarizeOauthSyncFailure(sync) {
    if (sync.error) return sync.error.message;
    const chunks = [];
    if (sync.stdout) chunks.push(sync.stdout.toString('utf8'));
    if (sync.stderr) chunks.push(sync.stderr.toString('utf8'));
    const text = redactSensitiveText(chunks.join('\n')).trim();
    if (!text) return `exit ${sync.status}`;

    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const parsed = JSON.parse(lines[i]);
            if (parsed && parsed.error) {
                const errorText = String(parsed.error);
                if (errorText.includes('No quota-eligible OmniRoute Claude connection found')) {
                    return buildOmniRouteQuotaStatusMessage() || errorText;
                }
                return errorText;
            }
        } catch {}
    }
    return lines.slice(-3).join(' | ');
}

function sleepSync(ms) {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
}

function withFileLock(lockDir, fn) {
    const start = Date.now();
    while (true) {
        try {
            fs.mkdirSync(lockDir, { mode: 0o700 });
            break;
        } catch (err) {
            if (Date.now() - start > 60 * 1000) throw new Error(`Timed out waiting for lock ${lockDir}`);
            sleepSync(200);
        }
    }
    try {
        return fn();
    } finally {
        try { fs.rmdirSync(lockDir); } catch {}
    }
}

function copyIfExists(src, dest, mode = 0o600) {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, mode);
    return true;
}

function linkClaudeProjects(destClaudeDir, warnings) {
    const src = path.join(ROOT_CLAUDE_DIR, 'projects');
    const dest = path.join(destClaudeDir, 'projects');
    if (!fs.existsSync(src)) {
        warnings.push('root Claude projects directory missing; resume may not work');
        return;
    }
    try {
        if (fs.existsSync(dest)) return;
        fs.symlinkSync(src, dest, 'dir');
    } catch (err) {
        warnings.push(`projects link failed: ${err.message}`);
    }
}

function applyClaudeRuntimeEnv(childEnv, warnings) {
    if (!fs.existsSync(RUNTIME_ENV_PATH)) return;
    const runtime = readJson(RUNTIME_ENV_PATH, null);
    if (!runtime || runtime.authMethod !== 'long_lived_access_token' || !runtime.CLAUDE_CODE_OAUTH_TOKEN) return;
    const expiresAtMs = runtime.expiresAt ? Date.parse(runtime.expiresAt) : 0;
    if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + 60 * 1000) {
        childEnv.CLAUDE_CODE_OAUTH_TOKEN = runtime.CLAUDE_CODE_OAUTH_TOKEN;
        warnings.push(`using OmniRoute long-lived Claude token: ${runtime.connectionName || runtime.connectionId || 'unknown'}`);
    } else {
        warnings.push('OmniRoute long-lived Claude token is expired; ignoring runtime env');
    }
}

function importClaudeOAuthBack(home) {
    if (!home || !fs.existsSync(OAUTH_IMPORT_PATH)) return null;
    return withFileLock('/tmp/claude-oauth-sync.lock', () => {
        const sync = spawnSync(process.execPath, [OAUTH_IMPORT_PATH, '--home', home, '--quiet'], {
            cwd: config.workdir || '/root',
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60 * 1000
        });
        const output = redactSensitiveText([
            sync.stdout ? sync.stdout.toString('utf8') : '',
            sync.stderr ? sync.stderr.toString('utf8') : ''
        ].join('\n')).trim();
        return {
            status: sync.status,
            ok: !sync.error && sync.status === 0,
            error: sync.error ? sync.error.message : null,
            output: output.slice(-1000)
        };
    });
}

function prepareClaudeLaunch(config) {
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_BASE_URL;
    delete childEnv.ANTHROPIC_CUSTOM_HEADERS;
    delete childEnv.CLAUDE_CODE_USE_BEDROCK;
    delete childEnv.CLAUDE_CODE_USE_VERTEX;
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
    childEnv.CLAUDE_CODE_EFFORT_LEVEL = childEnv.CLAUDE_CODE_EFFORT_LEVEL || 'max';
    childEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = childEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT || '1';

    const isolate = config.isolateClaudeHome !== false;
    const officialPath = config.claudeOfficialPath || OFFICIAL_CLAUDE_PATH;
    const warnings = [];
    let claudePath = config.claudePath;
    let home = config.home || process.env.HOME || '/root';
    let launchMode = 'configured-home';

    if (isolate && fs.existsSync(officialPath)) {
        const isolatedHome = path.join(jobDir, 'home');
        const isolatedClaudeDir = path.join(isolatedHome, '.claude');
        fs.mkdirSync(isolatedClaudeDir, { recursive: true, mode: 0o700 });

        withFileLock('/tmp/claude-oauth-sync.lock', () => {
            if (fs.existsSync(OAUTH_SYNC_PATH)) {
                const sync = spawnSync(process.execPath, [OAUTH_SYNC_PATH, '--quiet', '--mark-use'], {
                    cwd: config.workdir || '/root',
                    env: { ...process.env },
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 60 * 1000
                });
                if (sync.error || sync.status !== 0) {
                    const reason = summarizeOauthSyncFailure(sync);
                    throw new Error(reason);
                }
            } else {
                warnings.push('oauth sync script missing');
            }

            const copiedCreds = copyIfExists(
                path.join(ROOT_CLAUDE_DIR, '.credentials.json'),
                path.join(isolatedClaudeDir, '.credentials.json'),
                0o600
            );
            if (!copiedCreds) warnings.push('root Claude credentials missing');

            copyIfExists(path.join(ROOT_CLAUDE_DIR, '.omniroute-sync.json'), path.join(isolatedClaudeDir, '.omniroute-sync.json'), 0o600);
            applyClaudeRuntimeEnv(childEnv, warnings);
            copyIfExists(path.join(ROOT_CLAUDE_DIR, 'settings.json'), path.join(isolatedClaudeDir, 'settings.json'), 0o600);
            copyIfExists(path.join(ROOT_CLAUDE_DIR, 'policy-limits.json'), path.join(isolatedClaudeDir, 'policy-limits.json'), 0o600);
            linkClaudeProjects(isolatedClaudeDir, warnings);
        });

        claudePath = officialPath;
        home = isolatedHome;
        launchMode = 'isolated-home';
    }

    childEnv.HOME = home;
    return { claudePath, childEnv, home, launchMode, warnings };
}

function resultErrorMessage(event, stderrBuf) {
    if (!event) return tailText(stderrBuf, 2000) || 'Claude failed without a result event';
    if (Array.isArray(event.errors) && event.errors.length) return event.errors.join('\n');
    if (event.result) return String(event.result);
    if (event.error) return String(event.error);
    if (event.message && typeof event.message === 'string') return event.message;
    if (event.api_error_status) return `Claude API error ${event.api_error_status}`;
    return tailText(stderrBuf, 2000) || 'Claude reported an error without details';
}

function envBool(value) {
    if (value === undefined || value === null || value === '') return undefined;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function loadConfig() {
    const config = readJson(configPath, {});
    if (process.env.CLAUDE_PATH) config.claudePath = process.env.CLAUDE_PATH;
    if (process.env.CLAUDE_WORKDIR) config.workdir = process.env.CLAUDE_WORKDIR;
    if (process.env.CLAUDE_HOME) config.home = process.env.CLAUDE_HOME;
    if (process.env.CLAUDE_MODEL) config.claudeModel = process.env.CLAUDE_MODEL;
    if (process.env.CLAUDE_ACCESS_DESCRIPTION) config.accessDescription = process.env.CLAUDE_ACCESS_DESCRIPTION;
    const skipDanger = envBool(process.env.CLAUDE_SKIP_DANGEROUSLY_SKIP_PERMISSIONS);
    if (skipDanger !== undefined) config.skipDangerouslySkipPermissions = skipDanger;
    return config;
}

function buildSystemPrompt(config, settings) {
    const parts = [];
    const accessDescription = config.accessDescription ||
        (process.platform === 'win32'
            ? 'Windows-компьютеру (PowerShell, файлы, сеть).'
            : 'Linux-серверу (Bash, файлы, сеть).');

    parts.push('Ты работаешь как ассистент в Telegram-боте. У тебя ' +
        (settings.fullAccess ? `полный доступ к ${accessDescription}` : 'ограниченный доступ.'));

    if (settings.language === 'ru') {
        parts.push('ЯЗЫК: всегда отвечай по-русски (исключение — код и куски логов на исходном языке).');
    } else if (settings.language === 'en') {
        parts.push('LANGUAGE: always answer in English (unless explicitly asked otherwise).');
    }

    if (settings.responseLength === 'brief') {
        parts.push('ДЛИНА: отвечай очень кратко, 1-2 предложения.');
    } else if (settings.responseLength === 'detailed') {
        parts.push('ДЛИНА: отвечай развёрнуто, со структурой и примерами.');
    }

    parts.push(
        'РАССУЖДЕНИЯ ВСЛУХ (ОЧЕНЬ ВАЖНО). Пользователь видит твой ход работы в Telegram в реальном времени. ' +
        'ПЕРЕД каждым вызовом инструмента (Bash/PowerShell/Read/Write/Edit/Glob/Grep/Web*/Task*) ОБЯЗАТЕЛЬНО пиши ' +
        'короткий текстовый комментарий (1-2 предложения): ЧТО ты собираешься сделать и ПОЧЕМУ. ' +
        'Не молчи — голый поток инструментов выглядит как чёрный ящик. ' +
        'Также комментируй важные промежуточные находки между шагами. ' +
        'Это правило ВАЖНЕЕ краткости — даже если responseLength=brief, перед инструментами комментарий обязателен.'
    );

    parts.push(
        'БРАУЗЕРНЫЕ ИНСТРУМЕНТЫ. Chromium/Google Chrome/Playwright на сервере доступны для задач, где реально нужен браузер. ' +
        'Для долгих браузерных операций используй разумные таймауты и закрывай browser/context после проверки, чтобы не оставлять фоновые процессы. ' +
        'Для простой диагностики предпочитай чтение файлов, логов, systemd, curl или API.'
    );

    parts.push(
        'ДОЛГИЕ ПРОЦЕССЫ И RUNTIME. Если нужно запустить сервер, daemon, watcher, runtime, bot, uvicorn/node/python service или любой процесс, который должен жить дольше 5-10 секунд, ' +
        'НИКОГДА не запускай его как foreground-команду Bash. Запускай через systemd-run/nohup/setsid с логом в файл и сразу возвращай управление. ' +
        'После запуска отдельной короткой командой проверь health/logs. Если нужно ждать внешний процесс (звонок, деплой, скан), делай короткие проверки по 5-15 секунд и между ними пиши пользователю статус.'
    );

    if (settings.fullAccess) {
        parts.push(
            'ПАМЯТЬ БЕЗ ПОДТВЕРЖДЕНИЙ. Если нужно сохранить долговременную память/заметку Claude Code, пиши markdown-файлы в ' +
            '`/root/.claude/projects/-root/memory/`. Не используй путь из текущего isolated HOME вида ' +
            '`.../runs-*/.../home/.claude/projects/.../memory/` — Claude Code считает его sensitive и может отклонить Write. ' +
            'Для memory-файлов НИКОГДА не используй Write/Edit/MultiEdit: сразу используй Bash heredoc ' +
            '(`mkdir -p ... && cat > ... <<\\\'EOF\\\'`). Не проси подтверждение у пользователя.'
        );
    }

    parts.push(
        'ФОРМАТ ВЫВОДА (TELEGRAM). Не markdown-рендер, а Telegram. ' +
        'Разрешено: **жирный**, `inline-код`, ```блоки кода```, [текст](url), списки через `-`. ' +
        'ЗАПРЕЩЕНО: заголовки `##` `###` `####` — они показываются как обычный текст с решётками. ' +
        'Для разделов используй **жирную** строку. ' +
        'Не злоупотребляй форматированием — пиши чисто и структурированно.'
    );

    parts.push(
        'ФАЙЛЫ ОТ ПОЛЬЗОВАТЕЛЯ. Когда пользователь присылает файл, бот сохраняет его локально и передаёт тебе путь в строке "ФАЙЛ:". ' +
        'Картинки можно «смотреть» через инструмент Read. Документы — читать как текст.'
    );
    parts.push(
        'ОТПРАВКА ФАЙЛОВ ПОЛЬЗОВАТЕЛЮ. Чтобы прислать файл в Telegram, добавь в ответ маркер ' +
        '[[SEND_FILE:полный\\путь\\к\\файлу]]. Бот извлечёт его и отправит, маркер удалит из текста.'
    );
    parts.push(
        'ВОПРОСЫ-ВЫБОР. Если нужно уточнение или подтверждение — НЕ пиши простым текстом «A или B?». ' +
        'Используй маркер [[ASK:вопрос?|вариант1|вариант2|вариант3]] (2-8 вариантов, разделитель `|`). ' +
        'Бот покажет это как кликабельные кнопки в Telegram, и выбор автоматически вернётся тебе.'
    );

    return parts.join('\n\n');
}

function buildClaudeArgs(config, settings, sessionId) {
    const args = ['-p'];
    if (config.claudeModel) args.push('--model', config.claudeModel);
    args.push('--output-format', 'stream-json', '--verbose');

    if (settings.fullAccess) {
        args.push('--permission-mode', config.fullAccessPermissionMode || 'acceptEdits');
        args.push('--allowed-tools', FULL_ACCESS_TOOLS.join(','));
        if (!config.skipDangerouslySkipPermissions && config.fullAccessPermissionMode === 'bypassPermissions') {
            args.push('--dangerously-skip-permissions');
        }
    } else {
        const tools = ['Read', 'Glob', 'Grep'];
        if (settings.webSearch) tools.push('WebSearch', 'WebFetch');
        args.push('--allowed-tools', tools.join(','));
    }

    const sysPrompt = buildSystemPrompt(config, settings);
    if (sysPrompt) args.push('--append-system-prompt', sysPrompt);
    if (sessionId && settings.rememberContext) args.push('--resume', sessionId);
    return args;
}

function summarizeTool(event) {
    if (!event || event.type !== 'assistant' || !event.message || !Array.isArray(event.message.content)) return null;
    for (const block of event.message.content) {
        if (block && block.type === 'tool_use') {
            return {
                name: block.name || '',
                input: block.input || {}
            };
        }
    }
    return null;
}

function resultErrorMessage(event, stderrBuf) {
    return event.result || event.message || event.error || event.api_error_status || tailText(stderrBuf, 2000) || 'Claude API error unknown';
}

function terminalStateFromResult(event, observedSessionId, stderrBuf, extra = {}) {
    const isError = !!event.is_error;
    const patch = {
        ...extra,
        status: isError ? 'error' : 'done',
        finishedAt: extra.finishedAt || new Date().toISOString(),
        resultEvent: event,
        result: event.result || event.message || '',
        session_id: event.session_id || observedSessionId || null,
        observedSessionId,
        api_error_status: event.api_error_status || null
    };
    if (isError) patch.error = resultErrorMessage(event, stderrBuf);
    return patch;
}

const job = readJson(jobFile, null);
if (!job) {
    console.error(`Job file not found or invalid: ${jobFile}`);
    process.exit(2);
}

const config = loadConfig();
const settings = job.settings || {};
const args = buildClaudeArgs(config, settings, job.sessionId);

let proc = null;
let stdoutBuf = '';
let stderrBuf = '';
let lastResultEvent = null;
let observedSessionId = null;
let eventCount = 0;
let terminalStateWritten = false;

function stopChild(signal = 'SIGTERM') {
    if (!proc || !proc.pid) return;
    try { process.kill(-proc.pid, signal); }
    catch {
        try { proc.kill(signal); } catch {}
    }
}

function failFastAuthRetry(event, launch) {
    if (!event || event.type !== 'system' || event.subtype !== 'api_retry') return false;
    if (Number(event.error_status) !== 401) return false;
    if (terminalStateWritten) return true;
    terminalStateWritten = true;
    const errMsg = 'Failed to authenticate. API Error: 401 Invalid authentication credentials';
    const authRouteBlock = markClaudeAuthCredentialRoute(launch.home, errMsg);
    const authRefresh = forceRefreshClaudeOAuthAfterAuthError(errMsg);
    const nowIso = new Date().toISOString();
    mergeState({
        status: 'error',
        finishedAt: nowIso,
        error: errMsg,
        api_error_status: 401,
        observedSessionId,
        session_id: event.session_id || observedSessionId || null,
        result: errMsg,
        authRouteBlock,
        authRefresh,
        failFastReason: 'auth_api_retry_401'
    });
    stopChild('SIGTERM');
    setTimeout(() => stopChild('SIGKILL'), 1500).unref();
    return true;
}

function handleExternalSignal(signal) {
    const current = readJson(stateFile, {});
    const patch = {
        status: 'stopping',
        stopSignal: signal,
        signalReceivedAt: new Date().toISOString()
    };
    if (!current.stopRequestedAt) {
        patch.externalSignal = signal;
        patch.externalSignalAt = patch.signalReceivedAt;
    }
    mergeState(patch);
    stopChild('SIGTERM');
}

process.on('SIGTERM', () => {
    handleExternalSignal('SIGTERM');
});
process.on('SIGINT', () => {
    handleExternalSignal('SIGINT');
});

try {
    const launch = prepareClaudeLaunch(config);
    mergeState({
        jobId: job.jobId,
        botId: job.botId,
        userId: job.userId,
        chatId: job.chatId,
        status: 'running',
        runnerPid: process.pid,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        claudePath: launch.claudePath,
        claudeHome: launch.home,
        launchMode: launch.launchMode,
        launchWarnings: launch.warnings,
        workdir: config.workdir,
        model: config.claudeModel || '',
        sessionId: job.sessionId || null
    });

    proc = spawn(launch.claudePath, args, {
        shell: false,
        cwd: config.workdir,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: launch.childEnv
    });

    mergeState({ claudePid: proc.pid, lastActivityAt: new Date().toISOString() });

    proc.stdout.on('data', d => {
        stdoutBuf += d.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const event = JSON.parse(trimmed);
                eventCount += 1;
                if (event.session_id && !observedSessionId) observedSessionId = event.session_id;
                if (event.type === 'system' && event.session_id) observedSessionId = event.session_id;
                if (failFastAuthRetry(event, launch)) {
                    appendEvent(event);
                    continue;
                }
                if (event.type === 'result') {
                    lastResultEvent = event;
                    if (!terminalStateWritten) {
                        terminalStateWritten = true;
                        const errMsg = event.is_error ? resultErrorMessage(event, stderrBuf) : '';
                        const monthlyLimitBlock = errMsg ? markClaudeMonthlyUsageLimit(launch.home, errMsg) : null;
                        const authRouteBlock = errMsg ? markClaudeAuthCredentialRoute(launch.home, errMsg) : null;
                        const authRefresh = errMsg ? forceRefreshClaudeOAuthAfterAuthError(errMsg) : null;
                        mergeState(terminalStateFromResult(event, observedSessionId, stderrBuf, {
                            resultReadyAt: new Date().toISOString(),
                            monthlyLimitBlock,
                            authRouteBlock,
                            authRefresh
                        }));
                        setTimeout(() => {
                            const latest = readJson(stateFile, {});
                            if (latest.status === 'done' || latest.status === 'error') stopChild('SIGTERM');
                        }, 1500).unref();
                    }
                }
                appendEvent(event);
                const lastTool = summarizeTool(event);
                const patch = {
                    lastActivityAt: new Date().toISOString(),
                    lastEventAt: new Date().toISOString(),
                    eventCount,
                    observedSessionId
                };
                if (lastTool) patch.lastTool = lastTool;
                if (event.type === 'rate_limit_event') patch.lastRateLimit = event.rate_limit_info || null;
                mergeState(patch);
            } catch {
                appendEvent({ type: 'raw_stdout', text: trimmed });
                mergeState({ lastActivityAt: new Date().toISOString(), rawStdoutTail: tailText(trimmed, 2000) });
            }
        }
    });

    proc.stderr.on('data', d => {
        const text = d.toString('utf8');
        stderrBuf += text;
        fs.appendFileSync(stderrFile, text);
        mergeState({
            lastActivityAt: new Date().toISOString(),
            stderrTail: tailText(stderrBuf)
        });
    });

    proc.on('error', err => {
        mergeState({
            status: 'error',
            finishedAt: new Date().toISOString(),
            error: err.message,
            observedSessionId,
            stderrTail: tailText(stderrBuf)
        });
    });

    proc.on('close', (code, signal) => {
        const oauthImportResult = launch.launchMode === 'isolated-home' ? importClaudeOAuthBack(launch.home) : null;
        const current = readJson(stateFile, {});
        const stopRequested = !!current.stopRequestedAt && !!current.stopRequestedBy;
        const externalSignal = !stopRequested && current.externalSignal;
        const base = {
            finishedAt: new Date().toISOString(),
            exitCode: code,
            exitSignal: signal,
            observedSessionId,
            stderrTail: tailText(stderrBuf),
            stdoutTail: tailText(stdoutBuf),
            oauthImport: oauthImportResult
        };
        if (terminalStateWritten) {
            mergeState({
                ...base,
                status: current.status || (lastResultEvent && lastResultEvent.is_error ? 'error' : 'done'),
                processClosedAt: new Date().toISOString()
            });
            return;
        }
        if (stopRequested) {
            mergeState({
                ...base,
                status: 'stopped',
                error: `Claude stopped by user${signal ? ` (${signal})` : ''}`
            });
        } else if (externalSignal) {
            mergeState({
                ...base,
                status: 'error',
                error: `Claude interrupted by external ${externalSignal}`,
                externalSignal,
                signalReceivedAt: current.signalReceivedAt || null
            });
        } else if (!lastResultEvent) {
            mergeState({
                ...base,
                status: 'error',
                error: 'Claude finished without result event'
            });
        } else if (lastResultEvent.is_error) {
            const errMsg = resultErrorMessage(lastResultEvent, stderrBuf);
            const monthlyLimitBlock = markClaudeMonthlyUsageLimit(launch.home, errMsg);
            const authRouteBlock = markClaudeAuthCredentialRoute(launch.home, errMsg);
            const authRefresh = forceRefreshClaudeOAuthAfterAuthError(errMsg);
            mergeState({
                ...base,
                monthlyLimitBlock,
                authRouteBlock,
                authRefresh,
                status: 'error',
                error: errMsg,
                api_error_status: lastResultEvent.api_error_status || null,
                resultEvent: lastResultEvent,
                result: lastResultEvent.result || lastResultEvent.message || '',
                session_id: lastResultEvent.session_id || observedSessionId || null
            });
        } else if (code !== 0) {
            mergeState({
                ...base,
                status: 'error',
                error: `Claude exit ${code}${signal ? ` signal ${signal}` : ''}`,
                resultEvent: lastResultEvent,
                result: lastResultEvent.result || lastResultEvent.message || '',
                session_id: lastResultEvent.session_id || observedSessionId || null
            });
        } else {
            mergeState({
                ...base,
                status: 'done',
                resultEvent: lastResultEvent,
                result: lastResultEvent.result || lastResultEvent.message || '',
                session_id: lastResultEvent.session_id || observedSessionId || null
            });
        }
    });

    proc.stdin.write(job.prompt || '', 'utf8');
    proc.stdin.end();
} catch (err) {
    mergeState({
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: err.message,
        observedSessionId,
        stderrTail: tailText(stderrBuf)
    });
    process.exitCode = 1;
}
