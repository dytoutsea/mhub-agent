import { readFile } from "node:fs/promises";

import { type RunningEchoServer, startEchoServer } from "./echo-server.js";
import { type RunningSocks5Observer, startSocks5Observer } from "./socks5-observer.js";
import { runSocks5EchoProbe } from "./socks5-probe.js";

const command = process.argv[2];

try {
  switch (command) {
    case "echo":
      await runEchoServers();
      break;
    case "socks":
      await runSocksObserver();
      break;
    case "probe":
      await runProbe();
      break;
    default:
      throw new Error("USAGE: cli.js <echo|socks|probe>");
  }
} catch (error) {
  writeEvent({ event: "poc_command_failed", error_code: stableError(error) });
  process.exitCode = 1;
}

async function runEchoServers() {
  const host = environment("MHUB_POC_ECHO_HOST", "127.0.0.1");
  const servers: RunningEchoServer[] = [];
  try {
    servers.push(
      await startEchoServer({
        host,
        port: integerEnvironment("MHUB_POC_ECHO_TCP_PORT", 19_080, true),
        transport: "tcp",
      }),
    );

    const certificateFile = process.env.MHUB_POC_TLS_CERT_FILE;
    const keyFile = process.env.MHUB_POC_TLS_KEY_FILE;
    if (certificateFile || keyFile) {
      if (!certificateFile || !keyFile) {
        throw new Error("POC_TLS_CERT_AND_KEY_REQUIRED");
      }
      servers.push(
        await startEchoServer({
          host,
          port: integerEnvironment("MHUB_POC_ECHO_TLS_PORT", 19_443, true),
          transport: "tls",
          tls: {
            cert: await readFile(certificateFile),
            key: await readFile(keyFile),
          },
        }),
      );
    }
  } catch (error) {
    await Promise.all(servers.map((server) => server.close()));
    throw error;
  }

  for (const server of servers) {
    writeEvent({
      event: "echo_listening",
      host: server.host,
      port: server.port,
      transport: server.transport,
    });
  }
  await waitForShutdown(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });
}

async function runSocksObserver() {
  const dropAfterMs = optionalIntegerEnvironment("MHUB_POC_DROP_AFTER_MS");
  const observer: RunningSocks5Observer = await startSocks5Observer({
    host: environment("MHUB_POC_SOCKS_HOST", "127.0.0.1"),
    port: integerEnvironment("MHUB_POC_SOCKS_PORT", 11_080, true),
    username: requiredEnvironment("MHUB_POC_SOCKS_USERNAME"),
    password: requiredEnvironment("MHUB_POC_SOCKS_PASSWORD"),
    allowNonLoopbackBind: booleanEnvironment("MHUB_POC_ALLOW_NON_LOOPBACK_BIND"),
    allowPrivateTargets: booleanEnvironment("MHUB_POC_ALLOW_PRIVATE_TARGETS"),
    connectTimeoutMs: integerEnvironment("MHUB_POC_CONNECT_TIMEOUT_MS", 5_000, false),
    ...(dropAfterMs === undefined ? {} : { dropAfterMs }),
    onObservation: (observation) => writeEvent({ event: "socks_observation", ...observation }),
  });
  writeEvent({ event: "socks_listening", host: observer.host, port: observer.port });
  await waitForShutdown(() => observer.close());
}

async function runProbe() {
  const caFile = process.env.MHUB_POC_TLS_CA_FILE;
  const tlsCa = caFile ? await readFile(caFile) : undefined;
  const result = await runSocks5EchoProbe({
    proxyHost: environment("MHUB_POC_SOCKS_HOST", "127.0.0.1"),
    proxyPort: integerEnvironment("MHUB_POC_SOCKS_PORT", 11_080, false),
    username: requiredEnvironment("MHUB_POC_SOCKS_USERNAME"),
    password: requiredEnvironment("MHUB_POC_SOCKS_PASSWORD"),
    targetHost: requiredEnvironment("MHUB_POC_TARGET_HOST"),
    targetPort: integerEnvironment("MHUB_POC_TARGET_PORT", 19_080, false),
    addressType: environment("MHUB_POC_TARGET_ADDRESS_TYPE", "domain") === "ip" ? "ip" : "domain",
    transport: environment("MHUB_POC_TARGET_TRANSPORT", "tcp") === "tls" ? "tls" : "tcp",
    ...(tlsCa === undefined ? {} : { tlsCa }),
  });
  writeEvent({ event: "probe_succeeded", ...result });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name}_REQUIRED`);
  }
  return value;
}

function environment(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function booleanEnvironment(name: string): boolean {
  return process.env[name] === "true";
}

function integerEnvironment(name: string, fallback: number, allowZero: boolean): number {
  const raw = process.env[name] ?? `${fallback}`;
  const value = Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 65_535) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function optionalIntegerEnvironment(name: string): number | undefined {
  if (process.env[name] === undefined) {
    return undefined;
  }
  return integerEnvironment(name, 0, true);
}

function writeEvent(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function stableError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "UNKNOWN_ERROR";
  }
  return /^[A-Z0-9_: -]+$/.test(error.message) ? error.message : "UNEXPECTED_ERROR";
}

function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let closing = false;
    const shutdown = () => {
      if (closing) {
        return;
      }
      closing = true;
      void close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
