#!/usr/bin/env bash
set -euo pipefail

svc=claude-telegram-bot.service
hb=/run/claude-telegram-bot/heartbeat

if ! systemctl is-active --quiet "$svc"; then
  logger -t claude-telegram-bot-healthcheck "$svc inactive; restarting"
  systemctl restart "$svc"
  exit 0
fi

if [[ ! -s "$hb" ]]; then
  logger -t claude-telegram-bot-healthcheck "heartbeat missing while $svc is active; leaving it running"
  exit 0
fi

now_ms=$(( $(date +%s) * 1000 ))
last_ms=$(tr -cd '0-9' < "$hb" | head -c 20 || true)
last_ms=${last_ms:-0}

if ! [[ "$last_ms" =~ ^[0-9]+$ ]]; then
  logger -t claude-telegram-bot-healthcheck "heartbeat invalid while $svc is active; leaving it running"
  exit 0
fi

age_ms=$(( now_ms - last_ms ))
if (( age_ms > 900000 )); then
  logger -t claude-telegram-bot-healthcheck "heartbeat stale (${age_ms}ms) while $svc is active; leaving it running"
fi
