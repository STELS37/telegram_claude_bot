#!/usr/bin/env bash
set -u -o pipefail

LOCK_DIR=/tmp/claude-oauth-sync.lock
BOT_ROOT=/a0/usr/projects/telegram_claude_bot
IMPORT=/usr/local/sbin/import-claude-code-oauth-to-omniroute.js
SYNC=/usr/local/sbin/sync-omniroute-claude-code-oauth.js
REPORT=/usr/local/sbin/claude-oauth-health-report.js
LONG_LIVED_LIMITS=/usr/local/sbin/claude-long-lived-limit-cache.js
NODE=/usr/bin/node

log_json() {
  printf '%s\n' "$1"
}

seed_long_lived_limits() {
  if [ -x "$NODE" ] && [ -f "$LONG_LIVED_LIMITS" ]; then
    "$NODE" "$LONG_LIVED_LIMITS" --quiet >/dev/null 2>&1 || true
  fi
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log_json '{"ok":true,"skipped":true,"reason":"oauth lock busy"}'
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Recover tokens from finished/crashed bot runs. This is non-destructive and prints no secrets.
if [ -x "$NODE" ] && [ -f "$IMPORT" ] && [ -d "$BOT_ROOT" ]; then
  find "$BOT_ROOT" -path '*/home/.claude/.omniroute-sync.json' -type f -mtime -14 -print0 2>/dev/null | \
    while IFS= read -r -d '' meta; do
      home="${meta%/.claude/.omniroute-sync.json}"
      [ -f "$home/.claude/.credentials.json" ] || continue
      "$NODE" "$IMPORT" --home "$home" --quiet >/dev/null 2>&1 || true
    done
fi

seed_long_lived_limits

if [ -x "$NODE" ] && [ -f "$REPORT" ]; then
  "$NODE" "$REPORT" || true
fi

# Do not consume rotating OAuth refresh tokens while Claude Code is running.
if pgrep -af '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe|/a0/usr/projects/telegram_claude_bot/claude-runner.js' >/dev/null 2>&1; then
  log_json '{"ok":true,"refreshSkipped":true,"reason":"active Claude Code job"}'
  exit 0
fi

if [ -x "$NODE" ] && [ -f "$SYNC" ]; then
  "$NODE" "$SYNC" --quiet
  rc=$?
  if [ $rc -ne 0 ]; then
    log_json "{\"ok\":false,\"syncExitCode\":$rc}"
    exit $rc
  fi
fi

seed_long_lived_limits

if [ -x "$NODE" ] && [ -f "$REPORT" ]; then
  "$NODE" "$REPORT" || true
fi
