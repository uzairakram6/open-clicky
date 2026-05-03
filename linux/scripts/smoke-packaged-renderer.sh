#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

port="${CLICKY_SMOKE_CDP_PORT:-9233}"
session="${CLICKY_SMOKE_SESSION:-clicky-smoke}"
app="./dist/linux-unpacked/linux-clicky"

if [[ ! -x "$app" ]]; then
  echo "Missing packaged app at $app. Run npm run build first." >&2
  exit 1
fi

"$app" --remote-debugging-port="$port" --no-sandbox >/tmp/clicky-smoke.log 2>&1 &
pid=$!

cleanup() {
  agent-browser --session "$session" close >/dev/null 2>&1 || true
  kill "$pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

connected=0
for _ in {1..20}; do
  if agent-browser --session "$session" connect "$port" >/dev/null 2>&1; then
    connected=1
    break
  fi
  sleep 0.5
done

if [[ "$connected" != "1" ]]; then
  echo "Unable to connect to Clicky CDP port $port" >&2
  cat /tmp/clicky-smoke.log >&2 || true
  exit 1
fi

agent-browser --session "$session" wait 2000 >/dev/null

body="$(agent-browser --session "$session" eval "document.body.innerText")"

for expected in "Clicky" "Record" "Worker URL" "Screens" "Transcript"; do
  if [[ "$body" != *"$expected"* ]]; then
    echo "Packaged renderer did not expose expected text: $expected" >&2
    echo "$body" >&2
    exit 1
  fi
done

echo "Packaged renderer smoke test passed."
