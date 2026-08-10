#!/bin/sh
set -eu

if [ -z "${MHUB_RELAY_JAR:-}" ] || [ ! -f "$MHUB_RELAY_JAR" ]; then
  echo "MHUB_RELAY_JAR must point to a built mhub-relay JAR" >&2
  exit 1
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/mhub-relay-e2e.XXXXXX")
echo_pid=""
relay_pid=""
agent_pid=""

cleanup() {
  for process_id in "$agent_pid" "$relay_pid" "$echo_pid"; do
    if [ -n "$process_id" ]; then
      kill "$process_id" 2>/dev/null || true
    fi
  done
  rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

free_port() {
  node -e 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close();});'
}

wait_for_text() {
  file=$1
  expected=$2
  attempt=0
  while [ "$attempt" -lt 100 ]; do
    if [ -f "$file" ] && grep -q "$expected" "$file"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.1
  done
  echo "Timed out waiting for $expected" >&2
  return 1
}

websocket_port=$(free_port)
socks_port=$(free_port)
health_port=$(free_port)
echo_port=$(free_port)
proxy_id=cpx_local_e2e
socks_username=cpb_local_e2e
agent_ticket=$(openssl rand -hex 32)
socks_password=$(openssl rand -hex 32)

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -days 1 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$work_dir/localhost.key" \
  -out "$work_dir/localhost.crt" \
  >/dev/null 2>&1

npm run build --workspace @mhub/sdk-poc >/dev/null
npm run build --workspace @mhub/relay-agent >/dev/null

MHUB_POC_ECHO_HOST=127.0.0.1 \
MHUB_POC_ECHO_TCP_PORT="$echo_port" \
node tools/sdk-poc/dist/cli.js echo >"$work_dir/echo.log" 2>&1 &
echo_pid=$!
wait_for_text "$work_dir/echo.log" '"event":"echo_listening"'

MHUB_RELAY_PUBLIC_WSS_HOST=127.0.0.1 \
MHUB_RELAY_PUBLIC_WSS_PORT="$websocket_port" \
MHUB_RELAY_PRIVATE_SOCKS_HOST=127.0.0.1 \
MHUB_RELAY_PRIVATE_SOCKS_PORT="$socks_port" \
MHUB_RELAY_HEALTH_HOST=127.0.0.1 \
MHUB_RELAY_HEALTH_PORT="$health_port" \
MHUB_RELAY_DEV_PROXY_ID="$proxy_id" \
MHUB_RELAY_DEV_AGENT_TICKET="$agent_ticket" \
MHUB_RELAY_DEV_SOCKS_USERNAME="$socks_username" \
MHUB_RELAY_DEV_SOCKS_PASSWORD="$socks_password" \
MHUB_RELAY_ALLOWED_TARGET_PORTS="$echo_port" \
MHUB_RELAY_ALLOW_PRIVATE_TARGETS=true \
MHUB_RELAY_TLS_CERTIFICATE_FILE="$work_dir/localhost.crt" \
MHUB_RELAY_TLS_PRIVATE_KEY_FILE="$work_dir/localhost.key" \
java -jar "$MHUB_RELAY_JAR" >"$work_dir/relay.log" 2>&1 &
relay_pid=$!
wait_for_text "$work_dir/relay.log" 'MHub Relay started'

NODE_EXTRA_CA_CERTS="$work_dir/localhost.crt" \
MHUB_AGENT_RELAY_CONTROL_URL="wss://127.0.0.1:$websocket_port/agent/v1/control" \
MHUB_AGENT_PROXY_ID="$proxy_id" \
MHUB_AGENT_SESSION_TICKET="$agent_ticket" \
MHUB_AGENT_ALLOW_PRIVATE_TARGETS=true \
node tools/relay-agent/dist/cli.js >"$work_dir/agent.log" 2>&1 &
agent_pid=$!
wait_for_text "$work_dir/agent.log" '"type":"online"'

MHUB_POC_SOCKS_HOST=127.0.0.1 \
MHUB_POC_SOCKS_PORT="$socks_port" \
MHUB_POC_SOCKS_USERNAME="$socks_username" \
MHUB_POC_SOCKS_PASSWORD="$socks_password" \
MHUB_POC_TARGET_HOST=127.0.0.1 \
MHUB_POC_TARGET_PORT="$echo_port" \
MHUB_POC_TARGET_ADDRESS_TYPE=ip \
node tools/sdk-poc/dist/cli.js probe >"$work_dir/probe.log"
grep -q '"event":"probe_succeeded"' "$work_dir/probe.log"

if MHUB_POC_SOCKS_HOST=127.0.0.1 \
  MHUB_POC_SOCKS_PORT="$socks_port" \
  MHUB_POC_SOCKS_USERNAME=wrong \
  MHUB_POC_SOCKS_PASSWORD=wrong \
  MHUB_POC_TARGET_HOST=127.0.0.1 \
  MHUB_POC_TARGET_PORT="$echo_port" \
  MHUB_POC_TARGET_ADDRESS_TYPE=ip \
  node tools/sdk-poc/dist/cli.js probe >"$work_dir/wrong-auth.log"; then
  echo "Invalid SOCKS5 credentials unexpectedly succeeded" >&2
  exit 1
fi
grep -q 'SOCKS_AUTHENTICATION_FAILED' "$work_dir/wrong-auth.log"

if MHUB_POC_SOCKS_HOST=127.0.0.1 \
  MHUB_POC_SOCKS_PORT="$socks_port" \
  MHUB_POC_SOCKS_USERNAME="$socks_username" \
  MHUB_POC_SOCKS_PASSWORD="$socks_password" \
  MHUB_POC_TARGET_HOST=localhost \
  MHUB_POC_TARGET_PORT="$echo_port" \
  MHUB_POC_TARGET_ADDRESS_TYPE=domain \
  node tools/sdk-poc/dist/cli.js probe >"$work_dir/domain.log"; then
  echo "SOCKS5 domain target unexpectedly succeeded" >&2
  exit 1
fi
grep -q 'SOCKS_CONNECT_FAILED_8' "$work_dir/domain.log"

echo "Relay WSS -> Node Agent IPv4 egress E2E passed"
