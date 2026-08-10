#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
OUTPUT_DIR="$REPOSITORY_ROOT/.agent-work/sdk-poc/tls"

umask 077
mkdir -p "$OUTPUT_DIR"

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -days 7 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$OUTPUT_DIR/localhost.key" \
  -out "$OUTPUT_DIR/localhost.crt" \
  >/dev/null 2>&1

printf '%s\n' "$OUTPUT_DIR"
