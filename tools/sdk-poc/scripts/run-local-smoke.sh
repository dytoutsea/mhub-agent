#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
EVIDENCE_ROOT="$REPOSITORY_ROOT/.agent-work/sdk-poc"
mkdir -p "$EVIDENCE_ROOT"
EVIDENCE_DIR=$(mktemp -d "$EVIDENCE_ROOT/smoke.XXXXXX")
TLS_DIR=$($SCRIPT_DIR/generate-certificate.sh)
ECHO_LOG="$EVIDENCE_DIR/echo.jsonl"
SOCKS_LOG="$EVIDENCE_DIR/socks.jsonl"
PROBE_LOG="$EVIDENCE_DIR/probes.jsonl"

POC_USERNAME=$(openssl rand -hex 12)
POC_PASSWORD=$(openssl rand -hex 24)
export MHUB_POC_SOCKS_USERNAME="$POC_USERNAME"
export MHUB_POC_SOCKS_PASSWORD="$POC_PASSWORD"
export MHUB_POC_ALLOW_PRIVATE_TARGETS=true
export MHUB_POC_TLS_CERT_FILE="$TLS_DIR/localhost.crt"
export MHUB_POC_TLS_KEY_FILE="$TLS_DIR/localhost.key"

ECHO_PID=""
SOCKS_PID=""

cleanup() {
  if [ -n "$SOCKS_PID" ]; then
    kill "$SOCKS_PID" 2>/dev/null || true
    wait "$SOCKS_PID" 2>/dev/null || true
  fi
  if [ -n "$ECHO_PID" ]; then
    kill "$ECHO_PID" 2>/dev/null || true
    wait "$ECHO_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

cd "$REPOSITORY_ROOT"
npm run build --workspace @mhub/sdk-poc >/dev/null
node tools/sdk-poc/dist/cli.js echo >"$ECHO_LOG" &
ECHO_PID=$!
node tools/sdk-poc/dist/cli.js socks >"$SOCKS_LOG" &
SOCKS_PID=$!

attempt=0
while [ "$attempt" -lt 50 ]; do
  if grep -q '"event":"echo_listening"' "$ECHO_LOG" \
    && grep -q '"event":"socks_listening"' "$SOCKS_LOG"; then
    break
  fi
  if ! kill -0 "$ECHO_PID" 2>/dev/null || ! kill -0 "$SOCKS_PID" 2>/dev/null; then
    printf '%s\n' "PoC process exited before readiness" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done

if [ "$attempt" -ge 50 ]; then
  printf '%s\n' "PoC readiness timed out" >&2
  exit 1
fi

MHUB_POC_TARGET_HOST=localhost \
MHUB_POC_TARGET_PORT=19080 \
MHUB_POC_TARGET_ADDRESS_TYPE=domain \
node tools/sdk-poc/dist/cli.js probe >>"$PROBE_LOG"

MHUB_POC_TARGET_HOST=127.0.0.1 \
MHUB_POC_TARGET_PORT=19080 \
MHUB_POC_TARGET_ADDRESS_TYPE=ip \
node tools/sdk-poc/dist/cli.js probe >>"$PROBE_LOG"

MHUB_POC_TARGET_HOST=localhost \
MHUB_POC_TARGET_PORT=19443 \
MHUB_POC_TARGET_ADDRESS_TYPE=domain \
MHUB_POC_TARGET_TRANSPORT=tls \
MHUB_POC_TLS_CA_FILE="$TLS_DIR/localhost.crt" \
node tools/sdk-poc/dist/cli.js probe >>"$PROBE_LOG"

node -e '
  const fs = require("node:fs");
  const events = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
  if (events.length !== 3 || events.some((event) => event.event !== "probe_succeeded")) {
    process.exit(1);
  }
' "$PROBE_LOG"

printf '%s\n' "$EVIDENCE_DIR"
