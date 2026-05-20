#!/usr/bin/env bash
set -euo pipefail

svc=claude-telegram-bot-parallel.service
hb=/run/claude-telegram-bot-parallel/heartbeat

if ! systemctl is-active --quiet "$svc"; then
  systemctl restart "$svc"
  exit 0
fi

if [[ ! -s "$hb" ]]; then
  systemctl restart "$svc"
  exit 0
fi

now_ms=$(( $(date +%s) * 1000 ))
last_ms=$(tr -cd '0-9' < "$hb" | head -c 20 || true)
last_ms=${last_ms:-0}

if ! [[ "$last_ms" =~ ^[0-9]+$ ]]; then
  systemctl restart "$svc"
  exit 0
fi

if (( now_ms - last_ms > 180000 )); then
  systemctl restart "$svc"
fi
