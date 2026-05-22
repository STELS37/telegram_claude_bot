# Telegram Claude Bot

Telegram bot bridge for Claude Code.

It keeps the original desktop bot behavior:

- streams Claude Code progress into Telegram;
- supports `/start`, `/menu`, `/new`, `/stop`, `/settings`, `/status`, `/help`;
- downloads user files into `incoming/<bot>/<user>/`;
- can send files back with `[[SEND_FILE:/absolute/path]]`;
- supports inline choice buttons with `[[ASK:question|option 1|option 2]]`;
- stores sessions and per-user settings separately per bot id.

## Install

```bash
npm ci --omit=dev
cp .env.example /etc/claude-telegram-bot.env
nano /etc/claude-telegram-bot.env
node bot.js config-linux.json
```

`TELEGRAM_BOT_TOKEN` and real credentials must stay outside git.

## Linux Service

The production service runs the bot from:

```text
/a0/usr/projects/telegram_claude_bot
```

Expected Claude entrypoint:

```text
/usr/bin/claude
```

If `/usr/bin/claude` is an OmniRoute/Claude Code wrapper, the bot automatically uses that rotation because it only calls the configured Claude CLI.

## Parallel Bot

For a second Telegram bot with an independent Claude session and user state, run the same `bot.js` with `config-linux-parallel.json` and a separate env file:

```text
/etc/claude-telegram-bot-parallel.env
```

The included `claude-telegram-bot-parallel.service` keeps its own heartbeat, sessions, settings, uploads, and pending inline choices under the `linux2` bot id.

## Claude OAuth Steward

Production uses a dedicated OAuth steward for OmniRoute/Claude Code token hygiene. It keeps the generic OmniRoute Claude health-check disabled because Claude OAuth refresh tokens are rotating and single-use. The steward still provides health monitoring, recovers refreshed tokens from completed bot runs, and refreshes the selected Claude account only when no Claude Code job is active.


The Claude account picker is intentionally stateful for bot jobs: `claude-runner.js` calls the OAuth sync script with `--mark-use`, so real bot runs update `last_used_at` and `consecutive_use_count`. Background steward checks do not mark usage. The rotator then prefers quota-eligible accounts with fresh reset/headroom while penalizing very recent consecutive use, which keeps the bot from sticking to one account when another account has just recovered.

Installed production paths:

```text
/usr/local/sbin/claude-oauth-health-report.js
/usr/local/sbin/claude-oauth-steward.sh
/usr/local/sbin/omniroute-claude-quota-rotate.js
/usr/local/sbin/sync-omniroute-claude-code-oauth.js
/etc/systemd/system/claude-code-oauth-sync.service
```

## Safety

Do not commit:

- Telegram tokens;
- Anthropic/Claude OAuth files;
- `.env` files;
- `sessions*.json`;
- `user-settings*.json`;
- logs, uploads, and crash dumps.
