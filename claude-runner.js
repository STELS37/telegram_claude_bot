const { spawn } = require('child_process');
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
        if (!config.skipDangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
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

const job = readJson(jobFile, null);
if (!job) {
    console.error(`Job file not found or invalid: ${jobFile}`);
    process.exit(2);
}

const config = loadConfig();
const settings = job.settings || {};
const args = buildClaudeArgs(config, settings, job.sessionId);
const childEnv = { ...process.env };
if (config.home) childEnv.HOME = config.home;
childEnv.CLAUDE_CODE_EFFORT_LEVEL = childEnv.CLAUDE_CODE_EFFORT_LEVEL || 'max';
childEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = childEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT || '1';

let proc = null;
let stdoutBuf = '';
let stderrBuf = '';
let lastResultEvent = null;
let observedSessionId = null;
let eventCount = 0;

function stopChild(signal = 'SIGTERM') {
    if (!proc || !proc.pid) return;
    try { process.kill(-proc.pid, signal); }
    catch {
        try { proc.kill(signal); } catch {}
    }
}

process.on('SIGTERM', () => {
    mergeState({ status: 'stopping', stopRequestedAt: new Date().toISOString(), stopSignal: 'SIGTERM' });
    stopChild('SIGTERM');
});
process.on('SIGINT', () => {
    mergeState({ status: 'stopping', stopRequestedAt: new Date().toISOString(), stopSignal: 'SIGINT' });
    stopChild('SIGTERM');
});

try {
    mergeState({
        jobId: job.jobId,
        botId: job.botId,
        userId: job.userId,
        chatId: job.chatId,
        status: 'running',
        runnerPid: process.pid,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        claudePath: config.claudePath,
        workdir: config.workdir,
        model: config.claudeModel || '',
        sessionId: job.sessionId || null
    });

    proc = spawn(config.claudePath, args, {
        shell: false,
        cwd: config.workdir,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: childEnv
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
                if (event.type === 'result') lastResultEvent = event;
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
        const stopRequested = !!current.stopRequestedAt;
        const base = {
            finishedAt: new Date().toISOString(),
            exitCode: code,
            exitSignal: signal,
            observedSessionId,
            stderrTail: tailText(stderrBuf),
            stdoutTail: tailText(stdoutBuf)
        };
        if (stopRequested) {
            mergeState({
                ...base,
                status: 'stopped',
                error: `Claude stopped by user${signal ? ` (${signal})` : ''}`
            });
        } else if (code !== 0) {
            mergeState({
                ...base,
                status: 'error',
                error: `Claude exit ${code}${signal ? ` signal ${signal}` : ''}`
            });
        } else if (!lastResultEvent) {
            mergeState({
                ...base,
                status: 'error',
                error: 'Claude finished without result event'
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
