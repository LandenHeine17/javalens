#!/usr/bin/env bash
# Starts the Java tracing server and the web UI. Open http://localhost:5173 afterwards.
set -e
cd "$(dirname "$0")"
java server/src/Main.java &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
[ -d web/node_modules ] || (cd web && npm install)
cd web && npx vite --open
