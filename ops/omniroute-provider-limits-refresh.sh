#!/usr/bin/env bash
set -euo pipefail

OMNIROUTE_DIR="${OMNIROUTE_DIR:-/a0/usr/projects/omniroute}"
URL="${OMNIROUTE_LIMITS_URL:-http://127.0.0.1:20128/api/usage/provider-limits}"
TIMEOUT="${OMNIROUTE_LIMITS_TIMEOUT:-90}"

log() { logger -t omniroute-provider-limits-refresh -- "$*"; echo "$*"; }

if ! command -v curl >/dev/null 2>&1; then
  log "ERROR: curl not found"
  exit 1
fi

if [ ! -d "$OMNIROUTE_DIR" ]; then
  log "ERROR: OmniRoute dir not found: $OMNIROUTE_DIR"
  exit 1
fi

CLI_TOKEN=$(cd "$OMNIROUTE_DIR" && node -e 'const crypto=require("node:crypto"); const { machineIdSync } = require("node-machine-id"); const salt=process.env.OMNIROUTE_CLI_SALT||"omniroute-cli-auth-v1"; process.stdout.write(crypto.createHmac("sha256", machineIdSync(true)).update(salt).digest("hex"));')
if [ -z "${CLI_TOKEN:-}" ]; then
  log "ERROR: failed to generate local OmniRoute CLI token"
  exit 1
fi

# Keep Claude OAuth access tokens fresh before OmniRoute reads provider limits.
# This avoids OmniRoute trying to refresh expired Claude tokens itself.
if [ -x /usr/bin/node ] && [ -f /usr/local/sbin/sync-omniroute-claude-code-oauth.js ]; then
  CLAUDE_SYNC_SKIP_PROVIDER_LIMITS_REFRESH=1 /usr/bin/node /usr/local/sbin/sync-omniroute-claude-code-oauth.js --refresh-all --quiet --skip-provider-limits >/dev/null 2>&1 || true
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

HTTP_CODE=$(curl -sS --max-time "$TIMEOUT" -o "$TMP" -w '%{http_code}' -X POST -H "x-omniroute-cli-token: $CLI_TOKEN" "$URL" || true)
if [ "$HTTP_CODE" != "200" ]; then
  BODY=$(head -c 500 "$TMP" | tr '\n' ' ')
  log "ERROR: refresh failed http=$HTTP_CODE body=$BODY"
  exit 1
fi

SUMMARY=$(node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const count=j.caches?Object.keys(j.caches).length:0;const failed=j.failed??0;const succeeded=j.succeeded??0;const total=j.total??count;const errors=j.errors?Object.keys(j.errors).length:0;console.log("ok total="+total+" succeeded="+succeeded+" failed="+failed+" caches="+count+" errors="+errors);}catch(e){console.log("ok unparsed");}});' < "$TMP" 2>/dev/null || echo "ok")
log "$SUMMARY"
