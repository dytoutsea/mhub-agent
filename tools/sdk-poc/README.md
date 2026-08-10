# SDK Feasibility PoC

This package supports Client Proxy MVP EPIC A without defining the production relay protocol. It provides:

- TCP/TLS echo service returning the observed client address.
- SOCKS5 username/password observer with structured, credential-free events.
- Domain/IP address-type probes for DNS-semantics evidence.
- Optional deterministic connection drops for SDK recovery tests.

It is test tooling, not a production relay or an open proxy.

## Safety Defaults

- SOCKS5 binds to `127.0.0.1` unless an explicit non-loopback acknowledgement is set.
- Username/password authentication is mandatory and has no default values.
- Loopback, private, link-local, multicast, reserved and mixed DNS results are blocked by default.
- Credentials and forwarded payloads are never included in observation events.
- `MHUB_POC_ALLOW_PRIVATE_TARGETS=true` exists only for controlled local echo tests.
- The package never invokes SDK create/stop/restore/login/message APIs.

Real SDK calls are side effects. Execute them only after separate authorization, using disposable test accounts and the SDK team's approved secret-injection method. Keep packet captures and raw responses under ignored `.agent-work/`; durable documents contain only redacted conclusions.

## Local Smoke Test

Run the automated CLI smoke. It generates ephemeral credentials in memory and stores only credential-free JSONL evidence under ignored `.agent-work/`:

```bash
npm run poc:smoke
```

The lower-level commands below are useful when exercising a real SDK or inspecting each process separately.

Generate an ephemeral seven-day certificate. The key stays under ignored `.agent-work/`:

```bash
npm run poc:certificate
```

Terminal 1, start TCP and TLS echo listeners:

```bash
MHUB_POC_TLS_CERT_FILE=.agent-work/sdk-poc/tls/localhost.crt \
MHUB_POC_TLS_KEY_FILE=.agent-work/sdk-poc/tls/localhost.key \
npm run poc:echo
```

Terminal 2, start the authenticated observer for local testing. Use values supplied through the environment; do not paste credentials into evidence or documentation:

```bash
MHUB_POC_SOCKS_USERNAME='<local-value>' \
MHUB_POC_SOCKS_PASSWORD='<local-value>' \
MHUB_POC_ALLOW_PRIVATE_TARGETS=true \
npm run poc:socks
```

Terminal 3, run a domain-address TCP probe:

```bash
MHUB_POC_SOCKS_USERNAME='<same-local-value>' \
MHUB_POC_SOCKS_PASSWORD='<same-local-value>' \
MHUB_POC_TARGET_HOST=localhost \
MHUB_POC_TARGET_PORT=19080 \
MHUB_POC_TARGET_ADDRESS_TYPE=domain \
npm run poc:probe
```

For TLS, set the target port to `19443`, transport to `tls`, and CA file to the generated certificate. For an IP-address handshake, set the target host to a literal IP and address type to `ip`.

## SDK Evidence Procedure

1. Deploy the observer only on an approved host reachable from the SDK node over a controlled network path.
2. Keep the default public-target policy. Set non-loopback bind acknowledgement only on that isolated host.
3. Inject a unique short-lived SOCKS5 username/password without printing the complete proxy URI.
4. Capture observer JSON lines and a packet capture with payload capture minimized.
5. Run each SDK separately with `is_long_proxy=true` and `use_proxy_resolved_ip=true`.
6. Record whether authentication is attempted and whether CONNECT uses `domain`, `ipv4`, or `ipv6`.
7. Record destination ports from `request` events; do not infer an allowlist from documentation alone.
8. Repeat with `MHUB_POC_DROP_AFTER_MS` to observe SDK failure and reconnection behavior.
9. Redact credentials, complete proxy URIs, SDK GUIDs and account identifiers before attaching conclusions to initiative status.

M0 remains blocked until both real SDK variants traverse the planned minimal relay plus Node Agent and reach the externally deployed echo target.
