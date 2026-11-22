#!/usr/bin/env bash
# Class mode: share JavaLens with a class from this laptop, for free (Linux).
#   ./class.sh             build if needed, start class mode, open a Cloudflare quick tunnel, print the link
#   ./class.sh --budget 1500 --max-runs 6    (optional: memory for student programs in MB, runs at once)
# Students open the printed link; everything runs here, each program in a sandbox. Ctrl+C ends class.
# Needs cloudflared (see README: "Using it with a class").
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-7171}"

if ! command -v cloudflared >/dev/null; then
  echo "cloudflared isn't installed. See README.md, \"Using it with a class\"." >&2
  exit 1
fi

./gradlew jar --quiet

# A fresh class code each time (letters only, no I or O).
CODE=$(LC_ALL=C tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZ' </dev/urandom 2>/dev/null | head -c 6 || true)
TUNNEL_LOG=$(mktemp)
SERVER=""; TUNNEL=""
cleanup() {
  [ -n "$TUNNEL" ] && kill "$TUNNEL" 2>/dev/null || true
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT INT TERM

java -jar build/libs/javalens.jar --class --port "$PORT" --code "$CODE" "$@" &
SERVER=$!
for _ in $(seq 1 60); do
  kill -0 "$SERVER" 2>/dev/null || { echo "JavaLens didn't start (see above)." >&2; exit 1; }
  curl -s -o /dev/null "http://127.0.0.1:$PORT/ping" && break
  sleep 0.5
done

cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$TUNNEL_LOG" 2>&1 &
TUNNEL=$!
URL=""
for _ in $(seq 1 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n 1 || true)
  [ -n "$URL" ] && break
  kill -0 "$TUNNEL" 2>/dev/null || break
  sleep 0.5
done
if [ -z "$URL" ]; then
  echo "The tunnel didn't start:" >&2
  cat "$TUNNEL_LOG" >&2
  exit 1
fi

echo
echo "  Give your students this link:   $URL/join/$CODE"
echo "  (open it yourself too. Ctrl+C ends class and the link stops working.)"
echo
wait "$SERVER"
