const TelegramBot = require('node-telegram-bot-api');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===================================================================
// CONFIG
// ===================================================================
// Path to config can be passed as CLI arg: node bot.js path/to/config.json
const configPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, 'config.json');

if (!fs.existsSync(configPath)) {
    console.error(`ERROR: config file not found: ${configPath}`); process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function parseAllowedUserIds(value) {
    return String(value || '')
        .split(',')
        .map(x => Number(x.trim()))
        .filter(Number.isSafeInteger);
}

function envBool(value) {
    if (value === undefined || value === null || value === '') return undefined;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}
function envInt(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : undefined;
}

// Server deployments keep secrets and host-specific paths in systemd env files.
// This lets the same bot logic run locally on Windows and remotely on Linux.
if (process.env.TELEGRAM_BOT_TOKEN) config.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
if (process.env.TELEGRAM_ALLOWED_USER_IDS) config.allowedUserIds = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
if (process.env.CLAUDE_PATH) config.claudePath = process.env.CLAUDE_PATH;
if (process.env.CLAUDE_WORKDIR) config.workdir = process.env.CLAUDE_WORKDIR;
if (process.env.CLAUDE_HOME) config.home = process.env.CLAUDE_HOME;
if (process.env.CLAUDE_MODEL) config.claudeModel = process.env.CLAUDE_MODEL;
if (process.env.CLAUDE_ACCESS_DESCRIPTION) config.accessDescription = process.env.CLAUDE_ACCESS_DESCRIPTION;
if (process.env.HEARTBEAT_PATH) config.heartbeatPath = process.env.HEARTBEAT_PATH;
const skipDanger = envBool(process.env.CLAUDE_SKIP_DANGEROUSLY_SKIP_PERMISSIONS);
if (skipDanger !== undefined) config.skipDangerouslySkipPermissions = skipDanger;
const claudeTimeoutOverride = envInt(process.env.CLAUDE_TIMEOUT_MS);
if (claudeTimeoutOverride !== undefined) config.claudeTimeoutMs = claudeTimeoutOverride;
const claudeStartupTimeoutOverride = envInt(process.env.CLAUDE_STARTUP_TIMEOUT_MS);
if (claudeStartupTimeoutOverride !== undefined) config.claudeStartupTimeoutMs = claudeStartupTimeoutOverride;
const claudeStallTimeoutOverride = envInt(process.env.CLAUDE_STALL_TIMEOUT_MS);
if (claudeStallTimeoutOverride !== undefined) config.claudeStallTimeoutMs = claudeStallTimeoutOverride;
const telegramRequestTimeoutOverride = envInt(process.env.TELEGRAM_REQUEST_TIMEOUT_MS);
if (telegramRequestTimeoutOverride !== undefined) config.telegramRequestTimeoutMs = telegramRequestTimeoutOverride;

// Bot id is used to keep sessions/settings/incoming files separate
// when multiple bots run in parallel from the same folder.
const BOT_ID = config.id || path.basename(configPath, '.json');

const SESSIONS_FILE = path.join(__dirname, `sessions-${BOT_ID}.json`);
const SETTINGS_FILE = path.join(__dirname, `user-settings-${BOT_ID}.json`);
const PENDING_CHOICES_FILE = path.join(__dirname, `pending-choices-${BOT_ID}.json`);
const INCOMING_DIR = path.join(__dirname, 'incoming', BOT_ID);
const RUNS_DIR = path.join(__dirname, `runs-${BOT_ID}`);
const CURRENT_JOBS_FILE = path.join(__dirname, `current-jobs-${BOT_ID}.json`);
const CLAUDE_RUNNER_PATH = path.join(__dirname, 'claude-runner.js');
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

// One-time migration from old single-bot file names ONLY for the "main" bot.
// Любой другой бот стартует с пустыми файлами — иначе все боты подхватят
// одну и ту же старую сессию и будут продолжать чужой контекст.
if (BOT_ID === 'main') {
    const legacySessions = path.join(__dirname, 'sessions.json');
    const legacySettings = path.join(__dirname, 'user-settings.json');
    if (!fs.existsSync(SESSIONS_FILE) && fs.existsSync(legacySessions)) {
        try { fs.copyFileSync(legacySessions, SESSIONS_FILE); } catch {}
    }
    if (!fs.existsSync(SETTINGS_FILE) && fs.existsSync(legacySettings)) {
        try { fs.copyFileSync(legacySettings, SETTINGS_FILE); } catch {}
    }
}

if (!config.telegramToken || config.telegramToken.startsWith('PASTE_')) {
    console.error(`ERROR: telegramToken in ${configPath} not set`); process.exit(1);
}
if (!config.claudePath || !fs.existsSync(config.claudePath)) {
    console.error(`ERROR: claudePath not found: ${config.claudePath}`); process.exit(1);
}
if (!Array.isArray(config.allowedUserIds)) config.allowedUserIds = [];
if (!fs.existsSync(config.workdir)) fs.mkdirSync(config.workdir, { recursive: true });
if (!fs.existsSync(INCOMING_DIR)) fs.mkdirSync(INCOMING_DIR, { recursive: true });
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

function writeHeartbeat() {
    if (!config.heartbeatPath) return;
    try {
        const heartbeatDir = path.dirname(config.heartbeatPath);
        if (!fs.existsSync(heartbeatDir)) fs.mkdirSync(heartbeatDir, { recursive: true });
        fs.writeFileSync(config.heartbeatPath, `${Date.now()}\n`);
    } catch (e) {
        console.error('heartbeat failed:', e.message);
    }
}
writeHeartbeat();
setInterval(writeHeartbeat, 30000).unref();

// ===================================================================
// USER SETTINGS
// ===================================================================
const DEFAULT_SETTINGS = {
    language: 'ru',
    responseLength: 'normal',
    rememberContext: true,
    fullAccess: true,
    webSearch: true,
    showProgress: true     // показывать что бот делает в реальном времени
};

function loadAllSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
    catch { return {}; }
}
function saveAllSettings(all) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2)); }
function getUserSettings(userId) {
    const all = loadAllSettings();
    return { ...DEFAULT_SETTINGS, ...(all[userId] || {}) };
}
function setUserSettings(userId, patch) {
    const all = loadAllSettings();
    all[userId] = { ...DEFAULT_SETTINGS, ...(all[userId] || {}), ...patch };
    saveAllSettings(all);
    return all[userId];
}

// ===================================================================
// SESSIONS
// ===================================================================
function loadSessions() {
    try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
    catch { return {}; }
}
function saveSessions(s) { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2)); }

// ===================================================================
// CLAUDE INVOCATION (STREAMING)
// ===================================================================
function buildClaudeArgs(settings, sessionId, streaming) {
    const args = ['-p'];
    if (config.claudeModel) args.push('--model', config.claudeModel);
    if (streaming) {
        args.push('--output-format', 'stream-json', '--verbose');
    } else {
        args.push('--output-format', 'json');
    }

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

    // ВАЖНО: append-system-prompt — настоящий системный промпт, Claude обязательно ему следует.
    // Кладём сюда все правила работы в Telegram-режиме.
    const sysPrompt = buildSystemPrompt(settings);
    if (sysPrompt) args.push('--append-system-prompt', sysPrompt);

    if (sessionId && settings.rememberContext) args.push('--resume', sessionId);
    return args;
}

function buildSystemPrompt(settings) {
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

    // ---- Narration / Thinking-out-loud ----
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

    // ---- Telegram formatting ----
    parts.push(
        'ФОРМАТ ВЫВОДА (TELEGRAM). Не markdown-рендер, а Telegram. ' +
        'Разрешено: **жирный**, `inline-код`, ```блоки кода```, [текст](url), списки через `-`. ' +
        'ЗАПРЕЩЕНО: заголовки `##` `###` `####` — они показываются как обычный текст с решётками. ' +
        'Для разделов используй **жирную** строку. ' +
        'Не злоупотребляй форматированием — пиши чисто и структурированно.'
    );

    // ---- File handling ----
    parts.push(
        'ФАЙЛЫ ОТ ПОЛЬЗОВАТЕЛЯ. Когда пользователь присылает файл, бот сохраняет его локально и передаёт тебе путь в строке "ФАЙЛ:". ' +
        'Картинки можно «смотреть» через инструмент Read. Документы — читать как текст.'
    );
    parts.push(
        'ОТПРАВКА ФАЙЛОВ ПОЛЬЗОВАТЕЛЮ. Чтобы прислать файл в Telegram, добавь в ответ маркер ' +
        '[[SEND_FILE:полный\\путь\\к\\файлу]]. Бот извлечёт его и отправит, маркер удалит из текста. ' +
        'Можно несколько маркеров. Пример: "Готово, отчёт здесь: [[SEND_FILE:C:\\Users\\1\\Desktop\\report.txt]]"'
    );

    // ---- Choice buttons ----
    parts.push(
        'ВОПРОСЫ-ВЫБОР. Если нужно уточнение или подтверждение — НЕ пиши простым текстом «A или B?». ' +
        'Используй маркер [[ASK:вопрос?|вариант1|вариант2|вариант3]] (2-8 вариантов, разделитель `|`). ' +
        'Бот покажет это как кликабельные кнопки в Telegram, и выбор автоматически вернётся тебе. ' +
        'Пример: [[ASK:Какой формат?|PDF|Word|TXT]]'
    );

    return parts.join('\n\n');
}

// Текст-префикс к пользовательскому сообщению (не системный промпт).
// Сейчас пуст — все правила переехали в --append-system-prompt.
function buildPromptPrefix(settings, isFirstMessage) {
    return '';
}

function callClaudeStream(prompt, settings, sessionId, onEvent, onSpawn) {
    return new Promise((resolve, reject) => {
        const args = buildClaudeArgs(settings, sessionId, true);
        const childEnv = { ...process.env };
        if (config.home) childEnv.HOME = config.home;
        childEnv.CLAUDE_CODE_EFFORT_LEVEL = childEnv.CLAUDE_CODE_EFFORT_LEVEL || 'max';
        childEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = childEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT || '1';
        const proc = spawn(config.claudePath, args, {
            shell: false,
            cwd: config.workdir,
            windowsHide: true,
            detached: process.platform !== 'win32',
            env: childEnv
        });
        if (onSpawn) { try { onSpawn(proc); } catch {} }

        let stdoutBuf = '';
        let stderrBuf = '';
        let lastResultEvent = null;
        let observedSessionId = null;  // ловим session_id из init-события — на случай если упадём до result
        let finished = false;
        let sawAnyOutput = false;
        let lastActivityAt = Date.now();

        // claudeTimeoutMs:
        //   0 (или отрицательное) — без таймаута, может работать сколько угодно
        //   N > 0 — максимум N миллисекунд, потом убиваем
        // В любом случае пользователь может прервать через /stop.
        const timeoutMs = (typeof config.claudeTimeoutMs === 'number' && config.claudeTimeoutMs > 0)
            ? config.claudeTimeoutMs
            : 0;
        const timeout = timeoutMs > 0 ? setTimeout(() => {
            failOnce(new Error(`Claude не ответил за ${Math.round(timeoutMs / 1000)} сек`));
        }, timeoutMs) : null;

        // Optional diagnostics-only guardrails. They are disabled by default
        // because long real work can be silent for a while. Set explicit
        // positive values in config/env only for temporary debugging.
        const startupTimeoutMs = (typeof config.claudeStartupTimeoutMs === 'number')
            ? config.claudeStartupTimeoutMs
            : 0;
        const stallTimeoutMs = (typeof config.claudeStallTimeoutMs === 'number')
            ? config.claudeStallTimeoutMs
            : 0;
        const startupTimeout = startupTimeoutMs > 0 ? setTimeout(() => {
            if (!sawAnyOutput) {
                failOnce(new Error(`Claude не начал отвечать за ${Math.round(startupTimeoutMs / 1000)} сек`));
            }
        }, startupTimeoutMs) : null;
        const stallInterval = stallTimeoutMs > 0 ? setInterval(() => {
            const silentFor = Date.now() - lastActivityAt;
            if (silentFor > stallTimeoutMs) {
                failOnce(new Error(`Claude молчит ${Math.round(silentFor / 1000)} сек; процесс прерван, чтобы бот не висел в typing`));
            }
        }, Math.min(60 * 1000, Math.max(10 * 1000, Math.floor(stallTimeoutMs / 4)))) : null;

        const clearT = () => {
            if (timeout) clearTimeout(timeout);
            if (startupTimeout) clearTimeout(startupTimeout);
            if (stallInterval) clearInterval(stallInterval);
        };
        function markActivity() {
            sawAnyOutput = true;
            lastActivityAt = Date.now();
            if (startupTimeout) clearTimeout(startupTimeout);
            writeHeartbeat();
        }
        function failOnce(err) {
            if (finished) return;
            finished = true;
            clearT();
            err.observedSessionId = observedSessionId;
            killProcessTree(proc);
            reject(err);
        }
        function resolveOnce(result) {
            if (finished) return;
            finished = true;
            clearT();
            resolve(result);
        }

        proc.stdout.on('data', d => {
            markActivity();
            stdoutBuf += d.toString('utf8');
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const event = JSON.parse(trimmed);
                    // session_id может быть в init-событии (system/subtype=init), либо в result.
                    if (event.session_id && !observedSessionId) observedSessionId = event.session_id;
                    if (event.type === 'system' && event.session_id) observedSessionId = event.session_id;
                    if (event.type === 'result') lastResultEvent = event;
                    try { onEvent(event); } catch (e) { console.error('onEvent error:', e); }
                } catch (e) {
                    // Non-JSON line — игнорируем
                }
            }
        });

        proc.stderr.on('data', d => {
            markActivity();
            stderrBuf += d.toString('utf8');
        });

        proc.on('error', err => { markActivity(); failOnce(err); });
        proc.on('close', code => {
            markActivity();
            if (finished) return;
            if (code !== 0) {
                // Дампим stderr и хвост stdout для диагностики
                try {
                    const debugDir = path.join(__dirname, 'crash-dumps');
                    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const dumpFile = path.join(debugDir, `${BOT_ID}-${stamp}-exit${code}.log`);
                    fs.writeFileSync(dumpFile,
                        `=== Claude exit ${code} ===\n` +
                        `Time: ${new Date().toISOString()}\n` +
                        `Session ID observed: ${observedSessionId || '(none)'}\n` +
                        `Args: ${args.map(a => a.length > 200 ? a.slice(0, 200) + '…' : a).join(' ')}\n\n` +
                        `=== STDERR (full) ===\n${stderrBuf}\n\n` +
                        `=== STDOUT TAIL (last 4000 chars) ===\n${stdoutBuf.slice(-4000)}\n`
                    );
                    console.log(`[crash-dump] ${dumpFile}`);
                } catch (e) { console.error('crash dump failed:', e.message); }

                const err = new Error(
                    `Claude exit ${code}` +
                    (stderrBuf ? `\nstderr: ${stderrBuf.slice(0, 500)}` : '\n(stderr пустой)')
                );
                err.observedSessionId = observedSessionId;
                return failOnce(err);
            }
            if (!lastResultEvent) {
                const err = new Error('Claude закончил без result-события\n' + stderrBuf.slice(0, 400));
                err.observedSessionId = observedSessionId;
                return failOnce(err);
            }
            resolveOnce(lastResultEvent);
        });

        proc.stdin.on('error', err => failOnce(err));
        try {
            proc.stdin.write(prompt, 'utf8');
            proc.stdin.end();
        } catch (err) {
            failOnce(err);
        }
    });
}

// ===================================================================
// FILE HANDLING
// ===================================================================
const FILE_TYPE_LABELS = {
    document: 'документ', photo: 'фото', voice: 'голосовое сообщение',
    audio: 'аудио', video: 'видео', sticker: 'стикер', video_note: 'видеосообщение'
};
function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 200);
}
async function downloadIncomingFile(bot, msg) {
    const userId = msg.from.id;
    const userDir = path.join(INCOMING_DIR, String(userId));
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    let fileId, suggestedName, kind;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    if (msg.document)      { fileId = msg.document.file_id; suggestedName = msg.document.file_name || `doc_${ts}`; kind='document'; }
    else if (msg.photo)    { fileId = msg.photo[msg.photo.length-1].file_id; suggestedName = `photo_${ts}.jpg`; kind='photo'; }
    else if (msg.voice)    { fileId = msg.voice.file_id; suggestedName = `voice_${ts}.ogg`; kind='voice'; }
    else if (msg.audio)    { fileId = msg.audio.file_id; suggestedName = msg.audio.file_name || `audio_${ts}.mp3`; kind='audio'; }
    else if (msg.video)    { fileId = msg.video.file_id; suggestedName = msg.video.file_name || `video_${ts}.mp4`; kind='video'; }
    else if (msg.video_note) { fileId = msg.video_note.file_id; suggestedName = `vnote_${ts}.mp4`; kind='video_note'; }
    else if (msg.sticker)  {
        fileId = msg.sticker.file_id;
        const ext = msg.sticker.is_animated ? 'tgs' : msg.sticker.is_video ? 'webm' : 'webp';
        suggestedName = `sticker_${ts}.${ext}`; kind='sticker';
    } else return null;

    suggestedName = sanitizeFilename(suggestedName);
    const downloadedPath = await bot.downloadFile(fileId, userDir);
    const finalPath = path.join(userDir, suggestedName);
    try {
        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        fs.renameSync(downloadedPath, finalPath);
    } catch (e) {
        return { path: downloadedPath, kind, caption: msg.caption || '' };
    }
    return { path: finalPath, kind, caption: msg.caption || '' };
}

function extractFilesToSend(text) {
    const regex = /\[\[SEND_FILE:([^\]\n]+)\]\]/g;
    const files = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        files.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
    const cleaned = text.replace(regex, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: cleaned, files };
}

function extractAsks(text) {
    // [[ASK:question|opt1|opt2|...]] — может быть несколько
    const regex = /\[\[ASK:([^\]\n]+?)\]\]/g;
    const asks = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        const parts = m[1].split('|').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
            asks.push({
                question: parts[0],
                options: parts.slice(1).slice(0, 8) // макс 8 вариантов
            });
        }
    }
    const cleaned = text.replace(regex, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: cleaned, asks };
}

function loadPendingChoices() {
    try {
        const raw = JSON.parse(fs.readFileSync(PENDING_CHOICES_FILE, 'utf8'));
        return new Map(Object.entries(raw || {}));
    } catch {
        return new Map();
    }
}
function savePendingChoices() {
    const obj = Object.fromEntries(pendingChoices);
    fs.writeFileSync(PENDING_CHOICES_FILE, JSON.stringify(obj, null, 2));
}

// Persistent store for pending choices: choiceId -> { userId, options[], createdAt }.
// Inline buttons may be pressed after a service restart, so memory-only state is too fragile.
const pendingChoices = loadPendingChoices();
function createPendingChoice(userId, options) {
    // короткий id из 6 символов
    const id = Math.random().toString(36).slice(2, 8);
    pendingChoices.set(id, { userId, options, createdAt: Date.now() });
    savePendingChoices();
    return id;
}
// Очистка старых выборов каждые 30 мин
setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    let changed = false;
    for (const [k, v] of pendingChoices) {
        if (v.createdAt < cutoff) {
            pendingChoices.delete(k);
            changed = true;
        }
    }
    if (changed) savePendingChoices();
}, 30 * 60 * 1000);

// ===================================================================
// PROGRESS DISPLAY
// ===================================================================
function describeToolUse(name, input) {
    const i = input || {};
    const trim = (s, n = 120) => {
        s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s;
    };
    switch (name) {
        case 'Bash':
        case 'PowerShell':
        case 'Shell':         return `💻 Команда: ${trim(i.command || i.script || '', 160)}`;
        case 'Read':          return `📖 Читаю: ${trim(i.file_path || i.path || '', 140)}`;
        case 'Write':         return `📝 Пишу файл: ${trim(i.file_path || i.path || '', 140)}`;
        case 'Edit':          return `✏ Правлю: ${trim(i.file_path || i.path || '', 140)}`;
        case 'MultiEdit':     return `✏ Множ. правки: ${trim(i.file_path || i.path || '', 140)}`;
        case 'NotebookEdit':  return `📓 Правлю ноутбук: ${trim(i.notebook_path || i.path || '', 140)}`;
        case 'Glob':          return `🔎 Ищу файлы: ${trim(i.pattern, 120)}`;
        case 'Grep':          return `🔎 Поиск по тексту: ${trim(i.pattern, 120)}`;
        case 'WebSearch':     return `🌐 Ищу в вебе: «${trim(i.query, 140)}»`;
        case 'WebFetch':      return `🌐 Открываю: ${trim(i.url, 160)}`;
        case 'TodoWrite':     return `📋 Обновляю список задач`;
        case 'Task':
        case 'Agent':         return `🤖 Подзадача: ${trim(i.description || i.subject || '', 120)}`;
        case 'ToolSearch':    return `🔧 Подгружаю инструмент: ${trim(i.query, 100)}`;
        case 'TaskCreate':    return `➕ Новая задача: ${trim(i.subject || i.description || '', 120)}`;
        case 'TaskUpdate':    return `🔄 Обновляю задачу: ${trim(i.status || i.subject || '', 100)}`;
        case 'TaskGet':       return `📌 Смотрю задачу: ${trim(i.taskId || '', 60)}`;
        case 'TaskList':      return `📋 Просматриваю список задач`;
        case 'TaskOutput':    return `📤 Читаю результат задачи: ${trim(i.task_id || '', 60)}`;
        case 'TaskStop':      return `⛔ Останавливаю задачу: ${trim(i.task_id || '', 60)}`;
        default: {
            // Для неизвестных инструментов — попробуем извлечь самые информативные поля
            const interesting = ['command','file_path','path','query','url','pattern','description','subject'];
            for (const k of interesting) if (i[k]) return `🛠 ${name}: ${trim(i[k], 140)}`;
            const raw = JSON.stringify(i).replace(/[{}"]/g, '');
            return `🛠 ${name}${raw ? ': ' + trim(raw, 120) : ''}`;
        }
    }
}

// ===================================================================
// FORMATTING
// ===================================================================
function splitForTelegram(text, maxLen) {
    const chunks = [];
    let rest = text;
    while (rest.length > maxLen) {
        let cut = rest.lastIndexOf('\n', maxLen);
        if (cut < maxLen / 2) cut = maxLen;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest.length) chunks.push(rest);
    return chunks;
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Converts CommonMark-style markdown (as Claude writes) into Telegram-compatible HTML.
// Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>.
// CommonMark headers (##, ###), **bold**, *italic*, `code`, ```code```, [text](url), lists.
function markdownToTelegramHtml(text) {
    if (!text) return '';
    const placeholders = [];
    const placehold = (content, type) => {
        const id = `__TG_PLACEHOLDER_${placeholders.length}__`;
        placeholders.push({ id, content, type });
        return id;
    };

    // Extract code blocks first so they don't get further processed
    text = text.replace(/```[ \t]*([a-zA-Z0-9_+\-]*)[ \t]*\n?([\s\S]*?)```/g,
        (m, lang, code) => placehold(code.replace(/\n+$/, ''), 'pre'));

    // Extract inline code
    text = text.replace(/`([^`\n]+)`/g, (m, code) => placehold(code, 'code'));

    // Escape any remaining HTML special chars
    text = escapeHtml(text);

    // Headers (#, ##, ###, ####, etc.) → bold on its own line
    text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '<b>$1</b>');

    // Bold: **text** or __text__
    text = text.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
    text = text.replace(/(^|[\s(])__([^_\n]+?)__(?=[\s).,;:!?]|$)/g, '$1<b>$2</b>');

    // Italic: *text* (single star) — only if NOT part of ** and not adjacent to word chars
    text = text.replace(/(^|[\s(])\*([^\s*][^*\n]*?[^\s*]|\S)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');

    // Strikethrough: ~~text~~
    text = text.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');

    // Links [text](url) — but skip if url contains spaces (likely not a real URL)
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
        return `<a href="${url}">${label}</a>`;
    });

    // Bullet markers — Telegram has no list styles, just keep the dash/dot
    // Convert leading `* ` (when used as list bullet) to `• ` so it doesn't conflict with italic markers
    text = text.replace(/^[ \t]*\*[ \t]+/gm, '• ');
    text = text.replace(/^[ \t]*-[ \t]+/gm, '• ');

    // Restore code placeholders
    for (const ph of placeholders) {
        const safe = escapeHtml(ph.content);
        const tag = ph.type === 'pre' ? `<pre>${safe}</pre>` : `<code>${safe}</code>`;
        text = text.replace(ph.id, () => tag);
    }

    return text;
}

// Strip markdown to plain text — fallback if Telegram rejects HTML
function stripMarkdown(text) {
    return String(text || '')
        .replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

// Send a message, rendering Claude's markdown via HTML; fallback to plain on error
async function sendRichMessage(chatId, text) {
    if (!text || !text.trim()) return;
    const chunks = splitForTelegram(text, config.maxMessageLength || 3800);
    for (const chunk of chunks) {
        const html = markdownToTelegramHtml(chunk);
        try {
            await bot.sendMessage(chatId, html, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (e) {
            const errMsg = String(e.message || e);
            if (errMsg.includes('parse') || errMsg.includes('entity') || errMsg.includes('HTML')) {
                // Markdown / HTML parse error — strip and resend plain
                try {
                    await bot.sendMessage(chatId, stripMarkdown(chunk), { disable_web_page_preview: true });
                } catch (e2) {
                    console.error('plain fallback also failed:', e2.message);
                }
            } else {
                console.error('sendRichMessage failed:', errMsg);
            }
        }
    }
}

// ===================================================================
// MENUS
// ===================================================================
const LANG_LABEL = { ru: 'Русский 🇷🇺', en: 'English 🇬🇧', auto: 'Авто' };
const LEN_LABEL = { brief: 'Краткий', normal: 'Обычный', detailed: 'Подробный' };

function mainMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '💬 Новый диалог', callback_data: 'cmd:new' }],
            [{ text: '⛔ Прервать запрос', callback_data: 'cmd:stop' }],
            [{ text: '⚙ Настройки', callback_data: 'menu:settings' }],
            [{ text: '📊 Статус', callback_data: 'cmd:status' }],
            [{ text: '❓ Помощь', callback_data: 'cmd:help' }]
        ]
    };
}
function settingsMenuKeyboard(s) {
    return {
        inline_keyboard: [
            [{ text: `🌐 Язык: ${LANG_LABEL[s.language]}`, callback_data: 'set:language' }],
            [{ text: `📏 Длина: ${LEN_LABEL[s.responseLength]}`, callback_data: 'set:responseLength' }],
            [{ text: `🧠 Контекст: ${s.rememberContext ? 'вкл ✅' : 'выкл ❌'}`, callback_data: 'set:rememberContext' }],
            [{ text: `🔓 Полный доступ к ПК: ${s.fullAccess ? 'вкл ✅' : 'выкл ❌'}`, callback_data: 'set:fullAccess' }],
            [{ text: `🌍 Веб-поиск: ${s.webSearch ? 'вкл ✅' : 'выкл ❌'}`, callback_data: 'set:webSearch' }],
            [{ text: `👁 Показывать прогресс: ${s.showProgress ? 'вкл ✅' : 'выкл ❌'}`, callback_data: 'set:showProgress' }],
            [{ text: '« В меню', callback_data: 'menu:main' }]
        ]
    };
}
function welcomeText() {
    return 'Привет! Я твой личный Claude в Telegram. 🤖\n\n' +
        'Пиши сообщения, присылай файлы (фото/документы/аудио/видео) — разберусь.\n' +
        'Могу и сам отправлять файлы — попроси «создай отчёт/таблицу/скрипт» и пришлю.\n\n' +
        'Каждый мой шаг (команды, чтение файлов, поиск) показываю в реальном времени.\n\n' +
        'Управление — кнопками ниже:';
}
function helpText() {
    return '📖 *Помощь*\n\n' +
        '*Что умею:*\n' +
        '• Отвечать на вопросы\n' +
        '• Читать/редактировать файлы на ПК\n' +
        '• Запускать команды PowerShell\n' +
        '• Принимать твои файлы — пиши с подписью что делать\n' +
        '• Отправлять файлы тебе\n' +
        '• Искать в интернете\n' +
        '• Помнить контекст\n\n' +
        '*Прогресс:*\n' +
        'В настройках есть «Показывать прогресс» — вижу каждый шаг (команда/чтение/поиск) в одном обновляемом сообщении.\n\n' +
        '*Вопросы от меня:*\n' +
        'Если мне нужно уточнение, я задам вопрос с кнопками — просто жми нужный вариант.\n\n' +
        '*Команды:*\n' +
        '/menu — главное меню\n' +
        '/new — новый диалог (сбросить контекст)\n' +
        '/stop — прервать текущий запрос\n' +
        '/settings — настройки\n' +
        '/status — статус сессии\n' +
        '/help — помощь';
}
function statusText(userId) {
    const s = getUserSettings(userId);
    const sid = loadSessions()[userId];
    return '📊 *Статус*\n\n' +
        `🆔 ID: \`${userId}\`\n` +
        `💬 Сессия: ${sid ? '`' + sid.slice(0, 8) + '…`' : 'нет'}\n\n` +
        '⚙ *Настройки:*\n' +
        `• Язык: ${LANG_LABEL[s.language]}\n` +
        `• Длина: ${LEN_LABEL[s.responseLength]}\n` +
        `• Контекст: ${s.rememberContext ? 'да' : 'нет'}\n` +
        `• Полный доступ: ${s.fullAccess ? 'да' : 'нет'}\n` +
        `• Веб-поиск: ${s.webSearch ? 'да' : 'нет'}\n` +
        `• Прогресс: ${s.showProgress ? 'да' : 'нет'}\n\n` +
        currentJobStatusText(userId);
}

// ===================================================================
// BOT
// ===================================================================
const telegramRequestTimeoutMs = (typeof config.telegramRequestTimeoutMs === 'number')
    ? config.telegramRequestTimeoutMs
    : 0;
const botOptions = {
    polling: {
        params: {
            timeout: 30,
            allowed_updates: ['message', 'callback_query']
        }
    }
};
if (telegramRequestTimeoutMs > 0) {
    botOptions.request = { timeout: telegramRequestTimeoutMs };
}
const bot = new TelegramBot(config.telegramToken, botOptions);
const isAllowed = (id) => Array.isArray(config.allowedUserIds) && config.allowedUserIds.includes(id);

function ts() { return new Date().toISOString().slice(11, 19); }
function log(...args) { console.log(`[${ts()}] [${BOT_ID}]`, ...args); }

// --- Per-user serial processing queue ---
// Чтобы Claude не запускался 5 раз параллельно над одной сессией.
const userQueues = new Map(); // userId -> Promise
function enqueueForUser(userId, fn) {
    const prev = userQueues.get(userId) || Promise.resolve();
    const next = prev.then(fn).catch(e => log('queue error for', userId, e.message));
    userQueues.set(userId, next);
    return next;
}

// --- Active claude.exe per user (for /stop) ---
const userActiveClaude = new Map(); // userId -> ChildProcess

// --- Track who manually /stop'd so we don't spam them with "Claude exit null" error ---
const recentlyStoppedUsers = new Set();
function markRecentlyStopped(userId) {
    recentlyStoppedUsers.add(userId);
    setTimeout(() => recentlyStoppedUsers.delete(userId), 5000);
}

// Kills the whole process tree (Claude + powershell.exe children, etc).
// Без этого после /stop остаются висеть процессы-сироты, продолжающие выполнять команду.
function killProcessTree(proc) {
    if (!proc || !proc.pid) return;
    if (process.platform === 'win32') {
        // taskkill /T = терминирует и все дочерние процессы, /F = форс
        try {
            spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
                shell: false, windowsHide: true, stdio: 'ignore'
            });
        } catch (e) {
            try { proc.kill('SIGKILL'); } catch {}
        }
    } else {
        try { process.kill(-proc.pid, 'SIGTERM'); }
        catch (e) { try { proc.kill('SIGTERM'); } catch {} }
        setTimeout(() => {
            try { process.kill(-proc.pid, 'SIGKILL'); }
            catch (e) { try { proc.kill('SIGKILL'); } catch {} }
        }, 1500);
    }
}

// ===================================================================
// PERSISTENT CLAUDE JOBS
// ===================================================================
function readJsonFile(file, fallback = {}) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}

function writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

function makeJobId(userId) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const suffix = crypto.randomBytes(4).toString('hex');
    return `${BOT_ID}-${userId}-${stamp}-${suffix}`;
}

function jobDir(jobId) { return path.join(RUNS_DIR, jobId); }
function jobFile(jobId) { return path.join(jobDir(jobId), 'job.json'); }
function stateFile(jobId) { return path.join(jobDir(jobId), 'state.json'); }
function eventsFile(jobId) { return path.join(jobDir(jobId), 'events.jsonl'); }

function readJob(jobId) { return readJsonFile(jobFile(jobId), null); }
function readJobState(jobId) { return readJsonFile(stateFile(jobId), null); }

function mergeJobState(jobId, patch) {
    const file = stateFile(jobId);
    const current = readJsonFile(file, {});
    writeJsonAtomic(file, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

function loadCurrentJobs() { return readJsonFile(CURRENT_JOBS_FILE, {}); }
function saveCurrentJobs(jobs) { writeJsonAtomic(CURRENT_JOBS_FILE, jobs); }
function setCurrentJob(userId, jobId) {
    const jobs = loadCurrentJobs();
    jobs[String(userId)] = jobId;
    saveCurrentJobs(jobs);
}
function clearCurrentJob(userId, jobId) {
    const jobs = loadCurrentJobs();
    const key = String(userId);
    if (!jobId || jobs[key] === jobId) {
        delete jobs[key];
        saveCurrentJobs(jobs);
    }
}

function isJobLive(state) {
    return !!state && ['queued', 'starting', 'running', 'stopping', 'sending'].includes(state.status);
}

function getCurrentLiveJob(userId) {
    const jobId = loadCurrentJobs()[String(userId)];
    if (!jobId) return null;
    const state = readJobState(jobId);
    if (isJobLive(state)) return { jobId, state };
    return null;
}

function formatAge(iso) {
    if (!iso) return 'нет';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 'нет';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec} сек`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} мин ${sec % 60} сек`;
    const hours = Math.floor(min / 60);
    return `${hours} ч ${min % 60} мин`;
}

function currentJobStatusText(userId) {
    const current = getCurrentLiveJob(userId);
    if (!current) return '🧵 Активная задача: нет';
    const { jobId, state } = current;
    const lastTool = state.lastTool
        ? `${state.lastTool.name || 'tool'}`
        : 'нет';
    const rate = state.lastRateLimit
        ? `${state.lastRateLimit.status || '?'} / ${state.lastRateLimit.rateLimitType || '?'}`
        : 'нет';
    return [
        '🧵 Активная задача: да',
        `• Job: \`${jobId}\``,
        `• Статус: \`${state.status || 'unknown'}\``,
        `• PID runner/Claude: \`${state.runnerPid || '-'}\` / \`${state.claudePid || '-'}\``,
        `• Unit: \`${state.systemdUnit || '-'}\``,
        `• Работает: ${formatAge(state.startedAt)}`,
        `• Последняя активность: ${formatAge(state.lastActivityAt)} назад`,
        `• Событий Claude: ${state.eventCount || 0}`,
        `• Последний tool: ${lastTool}`,
        `• Rate limit: ${rate}`
    ].join('\n');
}

function systemdUnitNameForJob(jobId) {
    return `claude-tg-job-${String(jobId).replace(/[^A-Za-z0-9_.-]/g, '-')}`.slice(0, 180);
}

function canUseSystemdRun() {
    return process.platform !== 'win32'
        && process.env.CLAUDE_RUNNER_SYSTEMD !== '0'
        && fs.existsSync('/run/systemd/system');
}

function startRunnerWithSystemd(jobId, dir) {
    if (!canUseSystemdRun()) return false;
    const unitName = systemdUnitNameForJob(jobId);
    const args = [
        `--unit=${unitName}`,
        '--collect',
        '--property=Type=simple',
        `--property=WorkingDirectory=${__dirname}`,
        '--property=KillMode=control-group',
        '--property=Restart=no',
        process.execPath,
        CLAUDE_RUNNER_PATH,
        dir,
        configPath
    ];
    const result = spawnSync('systemd-run', args, {
        cwd: __dirname,
        env: { ...process.env },
        encoding: 'utf8',
        timeout: 10000
    });
    if (result.status !== 0) {
        mergeJobState(jobId, {
            runnerLaunchMode: 'detached-fallback',
            systemdRunError: (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 2000)
        });
        return false;
    }
    mergeJobState(jobId, {
        runnerLaunchMode: 'systemd-run',
        systemdUnit: `${unitName}.service`,
        systemdRunOutput: (result.stdout || '').trim().slice(0, 1000)
    });
    return true;
}

function startClaudeJob(userId, chatId, prompt, settings, sessionId) {
    const jobId = makeJobId(userId);
    const dir = jobDir(jobId);
    fs.mkdirSync(dir, { recursive: true });
    const job = {
        jobId,
        botId: BOT_ID,
        userId,
        chatId,
        prompt,
        settings,
        sessionId: sessionId || null,
        configPath,
        createdAt: new Date().toISOString()
    };
    writeJsonAtomic(jobFile(jobId), job);
    writeJsonAtomic(stateFile(jobId), {
        jobId,
        botId: BOT_ID,
        userId,
        chatId,
        status: 'starting',
        createdAt: job.createdAt,
        updatedAt: job.createdAt
    });

    if (!startRunnerWithSystemd(jobId, dir)) {
        const runner = spawn(process.execPath, [CLAUDE_RUNNER_PATH, dir, configPath], {
            shell: false,
            cwd: __dirname,
            detached: process.platform !== 'win32',
            stdio: 'ignore',
            env: { ...process.env }
        });
        runner.unref();
        mergeJobState(jobId, {
            runnerPid: runner.pid,
            status: 'starting',
            runnerLaunchMode: 'detached'
        });
    }
    setCurrentJob(userId, jobId);
    return jobId;
}

function readNewEvents(jobId, offset) {
    const file = eventsFile(jobId);
    if (!fs.existsSync(file)) return { events: [], offset };
    const size = fs.statSync(file).size;
    if (offset > size) offset = 0;
    if (size === offset) return { events: [], offset };
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        const events = [];
        for (const line of buf.toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line)); } catch {}
        }
        return { events, offset: size };
    } finally {
        fs.closeSync(fd);
    }
}

function collectStepFromEvent(event) {
    if (!event || event.type !== 'assistant' || !event.message || !Array.isArray(event.message.content)) return [];
    const lines = [];
    for (const block of event.message.content) {
        if (block.type === 'tool_use') lines.push(describeToolUse(block.name, block.input));
    }
    return lines;
}

function collectThinkingFromEvent(event) {
    if (!event || event.type !== 'assistant' || !event.message || !Array.isArray(event.message.content)) return [];
    const blocks = event.message.content;
    const hasToolUse = blocks.some(b => b.type === 'tool_use');
    const out = [];
    for (const block of blocks) {
        if (block.type === 'text' && block.text && block.text.trim()) {
            out.push([hasToolUse ? '💭' : '💬', block.text.trim()]);
        } else if (block.type === 'thinking' && block.thinking && block.thinking.trim()) {
            out.push(['🧠', block.thinking.trim()]);
        }
    }
    return out;
}

function normalizeLiveText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function isAlreadySentLiveText(text, sentLiveTexts) {
    const normalized = normalizeLiveText(text);
    if (!normalized) return false;
    return sentLiveTexts.some(sent => sent === normalized);
}

function compactOneLine(text, max = 180) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function summarizeRunningTool(tool) {
    if (!tool) return '';
    const input = tool.input || {};
    const name = tool.name || 'tool';
    const detail = input.description || input.command || input.file_path || input.path || input.pattern || '';
    const compact = compactOneLine(detail, 180);
    return compact ? `${name} — ${compact}` : name;
}

const activeJobMonitors = new Map();

function stopActiveJobForUser(userId) {
    const current = getCurrentLiveJob(userId);
    if (!current) return null;
    const { jobId, state } = current;
    const now = new Date().toISOString();

    // Unblock the user immediately. The process tree is killed below, but the
    // Telegram UX must not wait for Claude/systemd to notice the signal.
    clearCurrentJob(userId, jobId);
    mergeJobState(jobId, {
        status: 'stopped',
        stopRequestedAt: now,
        stopRequestedBy: 'telegram',
        finishedAt: now,
        error: 'Claude stopped by user'
    });

    const targets = [state.claudePid, state.runnerPid].filter(Boolean);
    const killPid = (pid, signal) => {
        try { process.kill(-pid, signal); }
        catch { try { process.kill(pid, signal); } catch {} }
    };
    const systemctl = (args) => spawn('systemctl', args, {
        shell: false,
        stdio: 'ignore'
    }).unref();

    if (state.systemdUnit) {
        systemctl(['kill', '--signal=SIGTERM', '--kill-whom=all', state.systemdUnit]);
        systemctl(['kill', '--signal=SIGKILL', '--kill-whom=all', state.systemdUnit]);
        systemctl(['stop', state.systemdUnit]);
    }
    for (const pid of targets) killPid(pid, 'SIGTERM');
    setTimeout(() => {
        for (const pid of targets) killPid(pid, 'SIGKILL');
        const latest = readJobState(jobId);
        if (latest && latest.systemdUnit) {
            systemctl(['kill', '--signal=SIGKILL', '--kill-whom=all', latest.systemdUnit]);
            systemctl(['stop', latest.systemdUnit]);
        }
    }, 500).unref();
    return { jobId, state };
}

function startJobMonitor(jobId, options = {}) {
    if (activeJobMonitors.has(jobId)) return;
    const job = readJob(jobId);
    if (!job) return;
    activeJobMonitors.set(jobId, true);

    const chatId = job.chatId;
    const userId = job.userId;
    const settings = job.settings || getUserSettings(userId);
    let statusMsgId = options.statusMsgId || null;
    let eventOffset = options.replayFromStart ? 0 : (fs.existsSync(eventsFile(jobId)) ? fs.statSync(eventsFile(jobId)).size : 0);
    const steps = [];
    let lastEdit = 0;
    let editScheduled = false;
    let thinkingQueue = Promise.resolve();
    const sentLiveTexts = [];
    let lastIdleStatusAt = 0;

    const EDIT_THROTTLE_MS = 2500;
    const MAX_STATUS_CHARS = 3500;

    function renderStatus(finalLine = '') {
        let total = 0;
        const lines = [];
        for (let i = steps.length - 1; i >= 0; i--) {
            const line = steps[i];
            const add = line.length + 1;
            if (total + add > MAX_STATUS_CHARS) {
                lines.unshift(`… (${i + 1} ранее)`);
                break;
            }
            total += add;
            lines.unshift(line);
        }
        const state = readJobState(jobId);
        if (!lines.length) lines.push('🤔 Думаю…');
        lines.push('');
        lines.push(`Job: ${jobId}`);
        if (state && state.lastActivityAt) lines.push(`Последняя активность: ${formatAge(state.lastActivityAt)} назад`);
        if (state && state.status === 'running' && state.lastTool) {
            lines.push(`Сейчас выполняется: ${summarizeRunningTool(state.lastTool)}`);
        }
        if (finalLine) lines.push('', finalLine);
        return lines.join('\n');
    }

    async function refreshStatus(force = false) {
        if (!statusMsgId) return;
        const now = Date.now();
        if (!force && now - lastEdit < EDIT_THROTTLE_MS) {
            if (editScheduled) return;
            editScheduled = true;
            setTimeout(() => { editScheduled = false; refreshStatus(true).catch(() => {}); }, EDIT_THROTTLE_MS - (now - lastEdit));
            return;
        }
        lastEdit = now;
        try {
            await bot.editMessageText(renderStatus(), {
                chat_id: chatId, message_id: statusMsgId,
                disable_web_page_preview: true
            });
        } catch {}
    }

    function sendThinking(prefix, fullText) {
        const normalized = normalizeLiveText(fullText);
        if (normalized) sentLiveTexts.push(normalized);
        thinkingQueue = thinkingQueue.then(async () => {
            await sendRichMessage(chatId, prefix + ' ' + fullText);
        }).catch(() => {});
    }

    async function deliverFinal(state) {
        mergeJobState(jobId, { telegramStatus: 'sending', sendingAt: new Date().toISOString() });
        await thinkingQueue.catch(() => {});
        try {
            if (state.status === 'done') {
                const sessions = loadSessions();
                const sid = state.session_id || state.observedSessionId;
                if (sid && settings.rememberContext) {
                    sessions[userId] = sid;
                    saveSessions(sessions);
                }

                if (statusMsgId) {
                    try {
                        if (steps.length === 0) {
                            await bot.deleteMessage(chatId, statusMsgId);
                        } else {
                            await bot.editMessageText(renderStatus('✅ Готово'), {
                                chat_id: chatId, message_id: statusMsgId,
                                disable_web_page_preview: true
                            });
                        }
                    } catch {}
                }

                const rawText = state.result || (state.resultEvent && (state.resultEvent.result || state.resultEvent.message)) || '';
                const afterFiles = extractFilesToSend(rawText);
                const afterAsks = extractAsks(afterFiles.text);
                const cleanText = afterAsks.text;

                if (cleanText.trim() && !isAlreadySentLiveText(cleanText, sentLiveTexts)) {
                    await sendRichMessage(chatId, cleanText);
                }
                for (const filePath of afterFiles.files) {
                    try {
                        if (!fs.existsSync(filePath)) {
                            await bot.sendMessage(chatId, `⚠ Файл не найден: \`${filePath}\``, { parse_mode: 'Markdown' });
                            continue;
                        }
                        const stats = fs.statSync(filePath);
                        if (stats.size > 50 * 1024 * 1024) {
                            await bot.sendMessage(chatId, `⚠ Файл больше 50 МБ: \`${filePath}\``, { parse_mode: 'Markdown' });
                            continue;
                        }
                        await bot.sendChatAction(chatId, 'upload_document').catch(() => {});
                        await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath) });
                    } catch (e) {
                        await bot.sendMessage(chatId, `⚠ Ошибка отправки: ${e.message.slice(0, 200)}`);
                    }
                }

                for (const ask of afterAsks.asks) {
                    const choiceId = createPendingChoice(userId, ask.options);
                    const keyboard = {
                        inline_keyboard: ask.options.map((opt, i) => [{
                            text: opt.length > 60 ? opt.slice(0, 57) + '…' : opt,
                            callback_data: `choice:${choiceId}:${i}`
                        }])
                    };
                    await bot.sendMessage(chatId, '❓ ' + ask.question, { reply_markup: keyboard }).catch(e => {
                        console.error('send ASK failed:', e.message);
                    });
                }
                log(`job ${jobId} delivered, session=${String(state.session_id || '').slice(0, 8)}…`);
            } else if (state.status === 'stopped') {
                if (statusMsgId) {
                    try {
                        await bot.editMessageText(renderStatus('⛔ Прервано пользователем'), {
                            chat_id: chatId, message_id: statusMsgId,
                            disable_web_page_preview: true
                        });
                    } catch {}
                }
                await bot.sendMessage(chatId, '⛔ Текущий запрос и все дочерние процессы прерваны.').catch(() => {});
            } else {
                if (statusMsgId) {
                    try {
                        await bot.editMessageText(renderStatus('⚠ Ошибка'), {
                            chat_id: chatId, message_id: statusMsgId,
                            disable_web_page_preview: true
                        });
                    } catch {}
                }
                const errMsg = state.error || 'Claude job failed';
                const resumeMissing = String(state.error || '').includes('No conversation found with session ID');
                const sid = resumeMissing
                    ? (state.sessionId || null)
                    : (state.session_id || state.observedSessionId || state.sessionId || null);
                if (sid && settings.rememberContext) {
                    const sessions = loadSessions();
                    sessions[userId] = sid;
                    saveSessions(sessions);
                }
                const hint = sid ? '\n\nℹ Сессия сохранена. Просто напиши «продолжай» — попробую с того же места.' : '';
                for (const chunk of splitForTelegram('⚠ Ошибка:\n' + errMsg + hint, config.maxMessageLength || 3800)) {
                    await bot.sendMessage(chatId, chunk).catch(() => {});
                }
            }
            mergeJobState(jobId, { telegramStatus: 'delivered', deliveredAt: new Date().toISOString() });
        } catch (err) {
            mergeJobState(jobId, { telegramStatus: 'delivery_error', deliveryError: err.message });
            throw err;
        } finally {
            clearCurrentJob(userId, jobId);
            activeJobMonitors.delete(jobId);
        }
    }

    const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);
    const pollInterval = setInterval(async () => {
        try {
            writeHeartbeat();
            const read = readNewEvents(jobId, eventOffset);
            eventOffset = read.offset;
            for (const event of read.events) {
                if (settings.showProgress) {
                    for (const line of collectStepFromEvent(event)) {
                        steps.push(line);
                        refreshStatus();
                    }
                    for (const [prefix, text] of collectThinkingFromEvent(event)) {
                        sendThinking(prefix, text);
                    }
                }
            }
            const state = readJobState(jobId);
            if (!state) return;
            if (settings.showProgress && statusMsgId && state.status === 'running') {
                const now = Date.now();
                if (now - lastIdleStatusAt > 15000) {
                    lastIdleStatusAt = now;
                    refreshStatus();
                }
            }
            if (['done', 'error', 'stopped'].includes(state.status) && !state.deliveredAt) {
                clearInterval(pollInterval);
                clearInterval(typingInterval);
                await deliverFinal(state);
            }
        } catch (err) {
            log(`job monitor error for ${jobId}:`, err.message);
        }
    }, 2000);

    pollInterval.unref();
    typingInterval.unref();
}

function recoverActiveJobs() {
    for (const [userId, jobId] of Object.entries(loadCurrentJobs())) {
        const state = readJobState(jobId);
        if (!state) {
            clearCurrentJob(userId, jobId);
            continue;
        }
        if (['done', 'error', 'stopped'].includes(state.status) && state.deliveredAt) {
            clearCurrentJob(userId, jobId);
            continue;
        }
        startJobMonitor(jobId, { replayFromStart: false });
        log(`recovered job monitor ${jobId}, status=${state.status}`);
    }
}

// --- Media group batching ---
// Telegram отправляет каждую картинку альбома отдельным сообщением.
// Собираем их за ~700мс и обрабатываем одним промптом.
const mediaGroups = new Map(); // groupId -> { items: [{msg, fileInfo}], timer, chatId, userId, caption }
const MEDIA_GROUP_FLUSH_MS = 700;

// --- Text batching ---
// Если юзер шлёт несколько текстовых сообщений подряд (Telegram режет длинные сообщения,
// или просто торопится), склеиваем их в один промпт.
const userTextBatches = new Map(); // userId -> { items: [str], timer, chatId }
const TEXT_BATCH_FLUSH_MS = 900;

function flushUserTextBatch(userId) {
    const b = userTextBatches.get(userId);
    if (!b) return;
    userTextBatches.delete(userId);
    clearTimeout(b.timer);

    const combined = b.items.join('\n\n');
    log(`flushing batch of ${b.items.length} text msg(s) from ${userId}`);
    enqueueForUser(userId, async () => {
        await processUserMessage(userId, b.chatId, combined);
    });
}

function flushMediaGroup(groupId) {
    const g = mediaGroups.get(groupId);
    if (!g) return;
    mediaGroups.delete(groupId);
    clearTimeout(g.timer);

    enqueueForUser(g.userId, async () => {
        const fileLines = g.items.map((it, i) =>
            `${i + 1}. ${FILE_TYPE_LABELS[it.fileInfo.kind] || 'файл'}: ${it.fileInfo.path}`
        ).join('\n');
        const claudePrompt =
            `Пользователь прислал ${g.items.length} файлов одним альбомом.\n` +
            `ФАЙЛЫ:\n${fileLines}\n` +
            (g.caption ? `Подпись пользователя: ${g.caption}\n` : '') +
            `\nОбработай. Если подписи нет — опиши коротко что на каждом.`;
        log(`processing media group ${groupId}, ${g.items.length} items`);
        await processUserMessage(g.userId, g.chatId, claudePrompt);
    });
}

bot.on('message', async (msg) => {
    writeHeartbeat();
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!isAllowed(userId)) {
        bot.sendMessage(chatId, `Доступ запрещён. Ваш ID: \`${userId}\``, { parse_mode: 'Markdown' });
        log(`REJECTED user ${userId} (@${msg.from.username || '?'})`);
        return;
    }

    log(`msg from ${userId}: ${msg.text ? `"${msg.text.slice(0, 60)}"` : (msg.photo ? '[photo]' : msg.document ? '[doc]' : msg.voice ? '[voice]' : msg.audio ? '[audio]' : msg.video ? '[video]' : '[other]')}${msg.media_group_id ? ` (group ${msg.media_group_id})` : ''}`);

    // --- slash commands ---
    if (msg.text) {
        if (msg.text === '/start') { bot.sendMessage(chatId, welcomeText(), { reply_markup: mainMenuKeyboard() }); return; }
        if (msg.text === '/menu')  { bot.sendMessage(chatId, '🏠 Главное меню', { reply_markup: mainMenuKeyboard() }); return; }
        if (msg.text === '/new' || msg.text === '/reset') {
            const sessions = loadSessions(); delete sessions[userId]; saveSessions(sessions);
            bot.sendMessage(chatId, '✓ Новый диалог.'); return;
        }
        if (msg.text === '/stop') {
            const stoppedJob = stopActiveJobForUser(userId);
            if (stoppedJob) {
                markRecentlyStopped(userId);
                bot.sendMessage(chatId, `⛔ Останавливаю job \`${stoppedJob.jobId}\`.`, { parse_mode: 'Markdown' });
                log(`/stop by ${userId} — stopping job ${stoppedJob.jobId}`);
            } else {
                const proc = userActiveClaude.get(userId);
                if (proc) {
                    markRecentlyStopped(userId);
                    killProcessTree(proc);
                    userActiveClaude.delete(userId);
                    bot.sendMessage(chatId, '⛔ Остановлено. Текущий запрос и все его дочерние процессы прерваны.');
                    log(`/stop by ${userId} — killed legacy PID tree ${proc.pid}`);
                } else {
                    bot.sendMessage(chatId, 'Сейчас ничего не выполняется.');
                }
            }
            return;
        }
        if (msg.text === '/settings') {
            bot.sendMessage(chatId, '⚙ Настройки\n\nНажми, чтобы изменить:',
                { reply_markup: settingsMenuKeyboard(getUserSettings(userId)) }); return;
        }
        if (msg.text === '/status') { bot.sendMessage(chatId, statusText(userId), { parse_mode: 'Markdown' }); return; }
        if (msg.text === '/help')   { bot.sendMessage(chatId, helpText(), { parse_mode: 'Markdown' }); return; }
    }

    // --- file download (if any) ---
    let fileInfo = null;
    const hasFile = msg.document || msg.photo || msg.voice || msg.audio || msg.video || msg.video_note || msg.sticker;
    if (hasFile) {
        bot.sendChatAction(chatId, 'upload_document').catch(() => {});
        try {
            fileInfo = await downloadIncomingFile(bot, msg);
            log(`downloaded: ${fileInfo.path}`);
        } catch (e) {
            const errMsg = String(e.message || e);
            log('download failed:', errMsg);
            if (errMsg.includes('file is too big') || errMsg.includes('FILE_TOO_LARGE')) {
                bot.sendMessage(chatId, '⚠ Файл слишком большой (лимит 20 МБ).');
            } else {
                bot.sendMessage(chatId, '⚠ Не удалось скачать файл: ' + errMsg.slice(0, 300));
            }
            return;
        }
    }

    // --- media group: batch first ---
    if (fileInfo && msg.media_group_id) {
        const gid = msg.media_group_id;
        let g = mediaGroups.get(gid);
        if (!g) {
            g = { items: [], userId, chatId, caption: msg.caption || '', timer: null };
            mediaGroups.set(gid, g);
        }
        if (msg.caption && !g.caption) g.caption = msg.caption;
        g.items.push({ msg, fileInfo });
        if (g.timer) clearTimeout(g.timer);
        g.timer = setTimeout(() => flushMediaGroup(gid), MEDIA_GROUP_FLUSH_MS);
        return; // will be processed when group flushes
    }

    const userText = msg.text || msg.caption || '';
    if (!fileInfo && !userText) { bot.sendMessage(chatId, '🤷 Пустое сообщение.'); return; }

    // --- File (single, with optional caption) — process immediately ---
    if (fileInfo) {
        const kindLabel = FILE_TYPE_LABELS[fileInfo.kind] || 'файл';
        const claudePrompt =
            `Пользователь прислал ${kindLabel}.\n` +
            `ФАЙЛ: ${fileInfo.path}\n` +
            (userText ? `Подпись пользователя: ${userText}\n` : '') +
            `\nОбработай. Если подписи нет — опиши коротко что в файле.`;
        enqueueForUser(userId, async () => {
            log(`processing for ${userId}: ${claudePrompt.slice(0, 80).replace(/\n/g, ' ')}…`);
            await processUserMessage(userId, chatId, claudePrompt);
        });
        return;
    }

    // --- Pure text — batch with rapid follow-ups ---
    // Если придут ещё сообщения в ближайшие 900мс, они склеятся в один промпт.
    let b = userTextBatches.get(userId);
    if (!b) {
        b = { items: [], chatId, timer: null };
        userTextBatches.set(userId, b);
    }
    b.items.push(userText);
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => flushUserTextBatch(userId), TEXT_BATCH_FLUSH_MS);
});

async function processUserMessage(userId, chatId, prompt) {
    const current = getCurrentLiveJob(userId);
    if (current) {
        const state = current.state;
        await bot.sendMessage(
            chatId,
            `⏳ Уже выполняется job \`${current.jobId}\`.\n` +
            `Статус: \`${state.status || 'running'}\`\n` +
            `Последняя активность: ${formatAge(state.lastActivityAt)} назад\n\n` +
            'Напиши /status, чтобы посмотреть детали, или /stop, чтобы прервать.',
            { parse_mode: 'Markdown' }
        ).catch(() => {});
        return;
    }

    const startTs = Date.now();
    const settings = getUserSettings(userId);
    const sessions = loadSessions();
    const existingSession = sessions[userId];
    const useResume = settings.rememberContext && !!existingSession;
    const fullPrompt = buildPromptPrefix(settings, !useResume) + prompt;

    log(`create job for ${userId}, session=${existingSession ? existingSession.slice(0, 8) + '…' : 'NEW'}, fullAccess=${settings.fullAccess}`);
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    let statusMsgId = null;
    if (settings.showProgress) {
        try {
            const m = await bot.sendMessage(chatId, '🤔 Думаю…');
            statusMsgId = m.message_id;
        } catch {}
    }

    try {
        const jobId = startClaudeJob(userId, chatId, fullPrompt, settings, useResume ? existingSession : null);
        log(`job ${jobId} started for ${userId} in ${Math.round((Date.now() - startTs) / 1000)}s`);
        startJobMonitor(jobId, { statusMsgId, replayFromStart: true });
    } catch (err) {
        if (statusMsgId) {
            try {
                await bot.editMessageText('⚠ Не удалось запустить Claude job', {
                    chat_id: chatId, message_id: statusMsgId,
                    disable_web_page_preview: true
                });
            } catch {}
        }
        log(`job create ERROR for ${userId}:`, err.message);
        await bot.sendMessage(chatId, '⚠ Не удалось запустить задачу:\n' + String(err.message || err)).catch(() => {});
    }
}

async function processUserMessageLegacy(userId, chatId, prompt) {
    const startTs = Date.now();
    const settings = getUserSettings(userId);
    const sessions = loadSessions();
    const existingSession = sessions[userId];
    log(`spawn claude for ${userId}, session=${existingSession ? existingSession.slice(0, 8) + '…' : 'NEW'}, fullAccess=${settings.fullAccess}`);
    const useResume = settings.rememberContext && !!existingSession;
    const isFirstMessage = !useResume;
    const fullPrompt = buildPromptPrefix(settings, isFirstMessage) + prompt;

    // initial typing
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);

    // Status message that gets edited as steps happen
    let statusMsgId = null;
    if (settings.showProgress) {
        try {
            const m = await bot.sendMessage(chatId, '🤔 Думаю…');
            statusMsgId = m.message_id;
        } catch (e) { /* ignore */ }
    }

    const steps = [];
    let lastEdit = 0;
    let editScheduled = false;
    const EDIT_THROTTLE_MS = 2500;
    const MAX_STATUS_CHARS = 3500;

    function renderStatus() {
        // Show as many recent steps as fit into MAX_STATUS_CHARS, starting from the latest
        let total = 0;
        const lines = [];
        for (let i = steps.length - 1; i >= 0; i--) {
            const line = steps[i];
            const add = line.length + 1;
            if (total + add > MAX_STATUS_CHARS) {
                lines.unshift(`… (${i + 1} ранее)`);
                break;
            }
            total += add;
            lines.unshift(line);
        }
        return lines.length ? lines.join('\n') : '🤔 Думаю…';
    }

    async function refreshStatus(force = false) {
        if (!statusMsgId) return;
        const now = Date.now();
        if (!force && now - lastEdit < EDIT_THROTTLE_MS) {
            if (editScheduled) return;
            editScheduled = true;
            setTimeout(() => { editScheduled = false; refreshStatus(true).catch(() => {}); }, EDIT_THROTTLE_MS - (now - lastEdit));
            return;
        }
        lastEdit = now;
        try {
            await bot.editMessageText(renderStatus(), {
                chat_id: chatId, message_id: statusMsgId,
                disable_web_page_preview: true
            });
        } catch (e) {
            // ignore "message is not modified" / rate limits
        }
    }

    // Queue thinking messages so they appear in order
    let thinkingQueue = Promise.resolve();
    const sentLiveTexts = [];
    function sendThinking(prefix, fullText) {
        const normalized = normalizeLiveText(fullText);
        if (normalized) sentLiveTexts.push(normalized);
        thinkingQueue = thinkingQueue.then(async () => {
            await sendRichMessage(chatId, prefix + ' ' + fullText);
        });
    }

    try {
        const result = await callClaudeStream(
            fullPrompt,
            settings,
            useResume ? existingSession : null,
            (event) => {
                if (!settings.showProgress) return;
                if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
                    const blocks = event.message.content;
                    const hasToolUse = blocks.some(b => b.type === 'tool_use');
                    for (const block of blocks) {
                        if (block.type === 'tool_use') {
                            steps.push(describeToolUse(block.name, block.input));
                            refreshStatus();
                        } else if (block.type === 'text' && block.text && block.text.trim()) {
                            const text = block.text.trim();
                            sendThinking(hasToolUse ? '💭' : '💬', text);
                        } else if (block.type === 'thinking' && block.thinking && block.thinking.trim()) {
                            sendThinking('🧠', block.thinking.trim());
                        }
                    }
                }
            },
            (proc) => {
                // запомним процесс, чтобы можно было прервать через /stop
                userActiveClaude.set(userId, proc);
                proc.once('exit', () => {
                    if (userActiveClaude.get(userId) === proc) {
                        userActiveClaude.delete(userId);
                    }
                });
            }
        );

        // Дождёмся, пока все мысли отправятся, прежде чем слать финальный ответ
        await thinkingQueue.catch(() => {});

        clearInterval(typingInterval);

        if (result.session_id && settings.rememberContext) {
            sessions[userId] = result.session_id;
            saveSessions(sessions);
        }

        log(`claude done for ${userId} in ${Math.round((Date.now() - startTs) / 1000)}s, steps=${steps.length}, session=${(result.session_id || '').slice(0, 8)}…`);

        const rawText = result.result || result.message || '';
        const afterFiles = extractFilesToSend(rawText);
        const afterAsks = extractAsks(afterFiles.text);
        const cleanText = afterAsks.text;
        const files = afterFiles.files;
        const asks = afterAsks.asks;

        // Delete or finalize status message
        if (statusMsgId) {
            try {
                if (steps.length === 0) {
                    await bot.deleteMessage(chatId, statusMsgId);
                } else {
                    const finalStatus = renderStatus() + '\n\n✅ Готово';
                    await bot.editMessageText(finalStatus, {
                        chat_id: chatId, message_id: statusMsgId,
                        disable_web_page_preview: true
                    });
                }
            } catch (e) { /* ignore */ }
        }

        if (cleanText.trim() && !isAlreadySentLiveText(cleanText, sentLiveTexts)) {
            await sendRichMessage(chatId, cleanText);
        }
        for (const filePath of files) {
            try {
                if (!fs.existsSync(filePath)) {
                    await bot.sendMessage(chatId, `⚠ Файл не найден: \`${filePath}\``, { parse_mode: 'Markdown' });
                    continue;
                }
                const stats = fs.statSync(filePath);
                if (stats.size > 50 * 1024 * 1024) {
                    await bot.sendMessage(chatId, `⚠ Файл больше 50 МБ: \`${filePath}\``, { parse_mode: 'Markdown' });
                    continue;
                }
                await bot.sendChatAction(chatId, 'upload_document').catch(() => {});
                await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath) });
            } catch (e) {
                await bot.sendMessage(chatId, `⚠ Ошибка отправки: ${e.message.slice(0, 200)}`);
            }
        }

        // Send any ASK markers as inline-keyboard questions
        for (const ask of asks) {
            const choiceId = createPendingChoice(userId, ask.options);
            const keyboard = {
                inline_keyboard: ask.options.map((opt, i) => [{
                    text: opt.length > 60 ? opt.slice(0, 57) + '…' : opt,
                    callback_data: `choice:${choiceId}:${i}`
                }])
            };
            await bot.sendMessage(chatId, '❓ ' + ask.question, { reply_markup: keyboard }).catch(e => {
                console.error('send ASK failed:', e.message);
            });
        }
    } catch (err) {
        clearInterval(typingInterval);

        const wasManuallyStopped = recentlyStoppedUsers.has(userId);

        // Даже если упало — сохраняем session_id, чтобы можно было /resume и продолжить
        if (err.observedSessionId && settings.rememberContext) {
            sessions[userId] = err.observedSessionId;
            saveSessions(sessions);
            log(`saved session ${err.observedSessionId.slice(0, 8)}… despite error`);
        }

        if (statusMsgId) {
            try {
                await bot.editMessageText(
                    wasManuallyStopped ? renderStatus() + '\n\n⛔ Прервано пользователем' : renderStatus() + '\n\n⚠ Ошибка',
                    { chat_id: chatId, message_id: statusMsgId, disable_web_page_preview: true }
                );
            } catch {}
        }
        log(`${wasManuallyStopped ? 'STOPPED' : 'ERROR'} for ${userId} after ${Math.round((Date.now() - startTs) / 1000)}s, steps=${steps.length}:`, err.message);

        if (!wasManuallyStopped) {
            const errMsg = String(err.message || err);
            const hint = err.observedSessionId
                ? '\n\nℹ Сессия сохранена. Просто напиши «продолжай» — попробую с того же места.'
                : '';
            for (const chunk of splitForTelegram('⚠ Ошибка:\n' + errMsg + hint, config.maxMessageLength || 3800)) {
                await bot.sendMessage(chatId, chunk).catch(() => {});
            }
        }
    }
}

// --- inline keyboard ---
bot.on('callback_query', async (query) => {
    writeHeartbeat();
    const userId = query.from && query.from.id;
    const data = query.data || '';
    let callbackAnswered = false;
    const answerCallback = async (options = {}) => {
        if (callbackAnswered) return;
        callbackAnswered = true;
        try { await bot.answerCallbackQuery(query.id, options); }
        catch (e) { log('answerCallbackQuery failed:', e.message); }
    };

    log(`callback from ${userId}: ${data || '(empty)'}${query.message ? '' : ' (no message)'}`);

    if (!isAllowed(userId)) {
        await answerCallback({ text: 'Доступ запрещён', show_alert: true }); return;
    }
    if (!query.message) {
        await answerCallback({ text: 'Сообщение с кнопкой недоступно', show_alert: true }); return;
    }

    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    try {
        // Handle ASK button click
        if (data.startsWith('choice:')) {
            const parts = data.split(':');
            const choiceId = parts[1];
            const index = parseInt(parts[2], 10);
            const choice = pendingChoices.get(choiceId);

            if (!choice || choice.userId !== userId) {
                await answerCallback({ text: '⌛ Выбор устарел или уже использован', show_alert: false });
                return;
            }
            if (Number.isNaN(index) || index < 0 || index >= choice.options.length) {
                await answerCallback({ text: 'Неверный вариант', show_alert: false });
                return;
            }
            const selected = choice.options[index];
            pendingChoices.delete(choiceId);
            savePendingChoices();
            log(`choice selected by ${userId}: ${selected.slice(0, 120)}`);

            // Acknowledge button press
            await answerCallback({ text: '✓ ' + selected.slice(0, 50) });

            // Update the question message: keep question, replace keyboard with selected
            try {
                const questionText = (query.message.text || '').replace(/^❓ /, '');
                await bot.editMessageText(`❓ ${questionText}\n\n✓ Выбрано: ${selected}`, {
                    chat_id: chatId, message_id: msgId
                });
            } catch (e) {
                log('choice message edit failed:', e.message);
            }

            // Send the chosen text back to Claude as if user typed it.
            // Keep it on the same per-user queue as normal messages; otherwise
            // a button press can overlap an already running Telegram request.
            enqueueForUser(userId, async () => {
                await processUserMessage(userId, chatId, selected);
            });
            return;
        }

        if (data === 'menu:main') {
            await answerCallback();
            await bot.editMessageText(welcomeText(), { chat_id: chatId, message_id: msgId, reply_markup: mainMenuKeyboard() });
        } else if (data === 'menu:settings') {
            await answerCallback();
            await bot.editMessageText('⚙ Настройки\n\nНажми, чтобы изменить:', {
                chat_id: chatId, message_id: msgId,
                reply_markup: settingsMenuKeyboard(getUserSettings(userId))
            });
        } else if (data === 'cmd:new') {
            const sessions = loadSessions(); delete sessions[userId]; saveSessions(sessions);
            await answerCallback({ text: '✓ Контекст сброшен' });
            await bot.sendMessage(chatId, '✓ Новый диалог.'); return;
        } else if (data === 'cmd:stop') {
            const stoppedJob = stopActiveJobForUser(userId);
            if (stoppedJob) {
                markRecentlyStopped(userId);
                await answerCallback({ text: '⛔ Останавливаю' });
                await bot.sendMessage(chatId, `⛔ Останавливаю job \`${stoppedJob.jobId}\`.`, { parse_mode: 'Markdown' });
                log(`/stop by ${userId} via button — stopping job ${stoppedJob.jobId}`);
            } else {
                const proc = userActiveClaude.get(userId);
                if (proc) {
                    markRecentlyStopped(userId);
                    killProcessTree(proc);
                    userActiveClaude.delete(userId);
                    await answerCallback({ text: '⛔ Остановлено' });
                    await bot.sendMessage(chatId, '⛔ Текущий запрос и все дочерние процессы прерваны.');
                    log(`/stop by ${userId} via button — killed legacy PID tree ${proc.pid}`);
                } else {
                    await answerCallback({ text: 'Ничего не выполняется', show_alert: false });
                }
            }
            return;
        } else if (data === 'cmd:status') {
            await answerCallback();
            await bot.sendMessage(chatId, statusText(userId), { parse_mode: 'Markdown' });
            return;
        } else if (data === 'cmd:help') {
            await answerCallback();
            await bot.sendMessage(chatId, helpText(), { parse_mode: 'Markdown' });
            return;
        } else if (data.startsWith('set:')) {
            const key = data.slice(4);
            const cur = getUserSettings(userId);
            let updated;
            if (key === 'language') {
                const o = ['ru', 'en', 'auto']; updated = setUserSettings(userId, { language: o[(o.indexOf(cur.language) + 1) % o.length] });
            } else if (key === 'responseLength') {
                const o = ['brief', 'normal', 'detailed']; updated = setUserSettings(userId, { responseLength: o[(o.indexOf(cur.responseLength) + 1) % o.length] });
            } else if (['rememberContext', 'fullAccess', 'webSearch', 'showProgress'].includes(key)) {
                updated = setUserSettings(userId, { [key]: !cur[key] });
            }
            if (!updated) {
                await answerCallback({ text: 'Неизвестная настройка', show_alert: false }); return;
            }
            await bot.editMessageReplyMarkup(settingsMenuKeyboard(updated), { chat_id: chatId, message_id: msgId });
            await answerCallback({ text: '✓ Сохранено' }); return;
        }
        await answerCallback();
    } catch (err) {
        log('callback_query error:', err.message);
        await answerCallback({ text: 'Ошибка: ' + err.message.slice(0, 100), show_alert: true });
    }
});

bot.on('polling_error', err => console.error('polling_error:', err.message));

bot.setMyCommands([
    { command: 'menu', description: 'Главное меню' },
    { command: 'new', description: 'Новый диалог (сбросить контекст)' },
    { command: 'stop', description: 'Прервать текущий запрос' },
    { command: 'settings', description: 'Настройки' },
    { command: 'status', description: 'Статус сессии' },
    { command: 'help', description: 'Помощь' }
]).catch(err => console.error('setMyCommands failed:', err.message));

console.log(`=== Claude Telegram Bot [${BOT_ID}] ===`);
console.log('Config file:    ', configPath);
console.log('Telegram bot:   ', config.label || '(no label)');
console.log('Allowed users:  ', config.allowedUserIds.join(', '));
console.log('Workdir:        ', config.workdir);
console.log('Sessions file:  ', SESSIONS_FILE);
console.log('Settings file:  ', SETTINGS_FILE);
console.log('Incoming dir:   ', INCOMING_DIR);
console.log('Runs dir:       ', RUNS_DIR);
recoverActiveJobs();
console.log('Polling Telegram...');
