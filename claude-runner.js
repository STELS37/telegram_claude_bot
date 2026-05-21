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
const ROOT_CLAUDE_DIR = '/root/.claude';
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

function availabilityFromBlockingWindows(account) {
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
    return availableAt || 'после обновления лимитов';
}

function blockerText(account) {
    const blockers = blockingWindows(account);
    if (!blockers.length) return 'ниже резерва';
    return blockers.map((status) => {
        const label = quotaWindowLabel(status.window) === '5ч' ? '5 часов' : '7 дней';
        return label + ': ' + quotaStatusText(status);
    }).join(', ');
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

function buildAccountLine(account, index) {
    const stale = blockingWindows(account).some((status) => {
        const ms = Date.now() - new Date(status.snapshotAt || 0).getTime();
        return Number.isFinite(ms) && ms > 20 * 60 * 1000;
    });
    return [
        String(index + 1) + '. ' + shortAccountName(account) + ' — ' + availabilityLine(account),
        '   Остаток: ' + accountReserveLine(account) + '.',
        '   Не проходит: ' + blockerText(account) + '.',
        stale ? '   Данные по этому аккаунту старые, OmniRoute обновит их отдельно.' : null
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
            if (at !== bt) return at - bt;
            return (b.score || 0) - (a.score || 0);
        })
        .slice(0, 5);

    const next = accounts[0] || null;
    const nextLines = next
        ? [
            'Ближайший запуск Opus 4.7:',
            shortAccountName(next) + ' — ' + availabilityLine(next) + '.',
            'Сейчас: ' + accountReserveLine(next) + '. Не хватает: ' + blockerText(next) + '.'
        ]
        : ['Ближайший запуск Opus 4.7: нет данных.'];

    return [
        'Сейчас Opus 4.7 запускать нельзя: все Claude-аккаунты ниже резерва.',
        '',
        ...nextLines,
        '',
        'Правило резерва: 5ч >= ' + (thresholds.sessionMinRemaining ?? 50) + '%, 7д >= ' + (thresholds.weeklyMinRemaining ?? 20) + '%.',
        '',
        'Все аккаунты:',
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

function prepareClaudeLaunch(config) {
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_BASE_URL;
    delete childEnv.ANTHROPIC_CUSTOM_HEADERS;
    delete childEnv.CLAUDE_CODE_USE_BEDROCK;
    delete childEnv.CLAUDE_CODE_USE_VERTEX;
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
                const sync = spawnSync(process.execPath, [OAUTH_SYNC_PATH, '--quiet'], {
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
                if (event.type === 'result') {
                    lastResultEvent = event;
                    if (!terminalStateWritten) {
                        terminalStateWritten = true;
                        mergeState(terminalStateFromResult(event, observedSessionId, stderrBuf, {
                            resultReadyAt: new Date().toISOString()
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
        const current = readJson(stateFile, {});
        const stopRequested = !!current.stopRequestedAt && !!current.stopRequestedBy;
        const externalSignal = !stopRequested && current.externalSignal;
        const base = {
            finishedAt: new Date().toISOString(),
            exitCode: code,
            exitSignal: signal,
            observedSessionId,
            stderrTail: tailText(stderrBuf),
            stdoutTail: tailText(stdoutBuf)
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
            mergeState({
                ...base,
                status: 'error',
                error: resultErrorMessage(lastResultEvent, stderrBuf),
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
