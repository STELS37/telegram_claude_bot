#!/usr/bin/env bash
set -euo pipefail

svc=claude-telegram-bot-parallel.service
hb=/run/claude-telegram-bot-parallel/heartbeat
max_age_ms=900000

if ! systemctl is-active --quiet "$svc"; then
  logger -t claude-telegram-bot-parallel-healthcheck "$svc inactive; restarting"
  systemctl restart "$svc"
  exit 0
fi

if [[ ! -s "$hb" ]]; then
  logger -t claude-telegram-bot-parallel-healthcheck "heartbeat missing; restarting $svc"
  systemctl restart "$svc"
  exit 0
fi

now_ms=$(( $(date +%s) * 1000 ))
last_ms=$(tr -cd '0-9' < "$hb" | head -c 20 || true)
last_ms=${last_ms:-0}

if ! [[ "$last_ms" =~ ^[0-9]+$ ]]; then
  logger -t claude-telegram-bot-parallel-healthcheck "heartbeat invalid; restarting $svc"
  systemctl restart "$svc"
  exit 0
fi

age_ms=$(( now_ms - last_ms ))
if (( age_ms > max_age_ms )); then
  logger -t claude-telegram-bot-parallel-healthcheck "heartbeat stale (${age_ms}ms > ${max_age_ms}ms); restarting $svc"
  systemctl restart "$svc"
fi
