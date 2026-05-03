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
for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:$port/json/version" >/dev/null 2>&1; then
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

sleep 1
if ! kill -0 "$pid" >/dev/null 2>&1; then
  echo "Packaged app exited during startup" >&2
  cat /tmp/clicky-smoke.log >&2 || true
  exit 1
fi

if ! grep -q "\[clicky:main\] app init started" /tmp/clicky-smoke.log; then
  echo "Packaged app did not reach main-process initialization" >&2
  cat /tmp/clicky-smoke.log >&2 || true
  exit 1
fi

if ! grep -Eq "\[clicky:wake\] (local wake-word listener started|wake word listener not started)" /tmp/clicky-smoke.log; then
  echo "Packaged app did not initialize or report wake-word listener state" >&2
  cat /tmp/clicky-smoke.log >&2 || true
  exit 1
fi

echo "Packaged renderer smoke test passed."
