const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// Bot id is used to keep sessions/settings/incoming files separate
// when multiple bots run in parallel from the same folder.
const BOT_ID = config.id || path.basename(configPath, '.json');

const SESSIONS_FILE = path.join(__dirname, `sessions-${BOT_ID}.json`);
const SETTINGS_FILE = path.join(__dirname, `user-settings-${BOT_ID}.json`);
const PENDING_CHOICES_FILE = path.join(__dirname, `pending-choices-${BOT_ID}.json`);
const INCOMING_DIR = path.join(__dirname, 'incoming', BOT_ID);

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
        if (!config.skipDangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
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

        // claudeTimeoutMs:
        //   0 (или отрицательное) — без таймаута, может работать сколько угодно
        //   N > 0 — максимум N миллисекунд, потом убиваем
        // В любом случае пользователь может прервать через /stop.
        const timeoutMs = (typeof config.claudeTimeoutMs === 'number' && config.claudeTimeoutMs > 0)
            ? config.claudeTimeoutMs
            : 0;
        const timeout = timeoutMs > 0 ? setTimeout(() => {
            killProcessTree(proc);
            reject(new Error(`Claude не ответил за ${Math.round(timeoutMs / 1000)} сек`));
        }, timeoutMs) : null;
        const clearT = () => { if (timeout) clearTimeout(timeout); };

        proc.stdout.on('data', d => {
            writeHeartbeat();
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
            writeHeartbeat();
            stderrBuf += d.toString('utf8');
        });

        proc.on('error', err => { writeHeartbeat(); clearT(); reject(err); });
        proc.on('close', code => {
            writeHeartbeat();
            clearT();
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
                return reject(err);
            }
            if (!lastResultEvent) {
                const err = new Error('Claude закончил без result-события\n' + stderrBuf.slice(0, 400));
                err.observedSessionId = observedSessionId;
                return reject(err);
            }
            resolve(lastResultEvent);
        });

        proc.stdin.write(prompt, 'utf8');
        proc.stdin.end();
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
        `• Прогресс: ${s.showProgress ? 'да' : 'нет'}`;
}

// ===================================================================
// BOT
// ===================================================================
const bot = new TelegramBot(config.telegramToken, {
    polling: {
        params: {
            timeout: 30,
            allowed_updates: ['message', 'callback_query']
        }
    }
});
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
            const proc = userActiveClaude.get(userId);
            if (proc) {
                markRecentlyStopped(userId);
                killProcessTree(proc);
                userActiveClaude.delete(userId);
                bot.sendMessage(chatId, '⛔ Остановлено. Текущий запрос и все его дочерние процессы прерваны.');
                log(`/stop by ${userId} — killed PID tree ${proc.pid}`);
            } else {
                bot.sendMessage(chatId, 'Сейчас ничего не выполняется.');
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
    function sendThinking(prefix, fullText) {
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
                            // Промежуточные мысли (текст вместе с tool_use) — шлём отдельным сообщением целиком.
                            if (hasToolUse) {
                                sendThinking('💭', text);
                            }
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

        if (cleanText.trim()) {
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

            // Send the chosen text back to Claude as if user typed it
            await processUserMessage(userId, chatId, selected);
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
            const proc = userActiveClaude.get(userId);
            if (proc) {
                markRecentlyStopped(userId);
                killProcessTree(proc);
                userActiveClaude.delete(userId);
                await answerCallback({ text: '⛔ Остановлено' });
                await bot.sendMessage(chatId, '⛔ Текущий запрос и все дочерние процессы прерваны.');
                log(`/stop by ${userId} via button — killed PID tree ${proc.pid}`);
            } else {
                await answerCallback({ text: 'Ничего не выполняется', show_alert: false });
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
console.log('Polling Telegram...');
