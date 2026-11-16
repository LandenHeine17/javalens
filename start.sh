#!/usr/bin/env bash
# Development mode: Java server with live reload of the web page.
# Starts the Java server (./gradlew run, port 7070) and the Vite dev server, then open http://localhost:5173
# (To try the real app instead: ./gradlew jar && java -jar build/libs/javalens.jar)
set -e
cd "$(dirname "$0")"
./gradlew run --quiet &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
[ -d web/node_modules ] || (cd web && npm ci)
cd web && npx vite --open
