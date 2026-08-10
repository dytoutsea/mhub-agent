import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";

import { startEchoServer } from "./echo-server.js";
import {
  type RunningSocks5Observer,
  type SocksObservation,
  startSocks5Observer,
} from "./socks5-observer.js";
import { openSocks5Tunnel, runSocks5EchoProbe } from "./socks5-probe.js";

const USERNAME = "poc-user";
const PASSWORD = "poc-password";

describe("SOCKS5 observer", () => {
  it("forwards a domain-address request and emits credential-free evidence", async () => {
    const observations: SocksObservation[] = [];
    const echo = await startEchoServer({ host: "127.0.0.1", port: 0, transport: "tcp" });
    const observer = await observerForTest(observations);
    try {
      const result = await runSocks5EchoProbe({
        ...proxyOptions(observer),
        targetHost: "localhost",
        targetPort: echo.port,
        addressType: "domain",
      });

      expect(result.addressType).toBe("domain");
      expect(result.echo.observed_remote_address).toBe("127.0.0.1");
      expect(observations).toContainEqual(
        expect.objectContaining({
          phase: "request",
          authentication: "username_password",
          addressType: "domain",
          destinationHost: "localhost",
          destinationPort: echo.port,
        }),
      );
      expect(JSON.stringify(observations)).not.toContain(USERNAME);
      expect(JSON.stringify(observations)).not.toContain(PASSWORD);
    } finally {
      await observer.close();
      await echo.close();
    }
  });

  it("distinguishes a literal IPv4 request", async () => {
    const observations: SocksObservation[] = [];
    const echo = await startEchoServer({ host: "127.0.0.1", port: 0, transport: "tcp" });
    const observer = await observerForTest(observations);
    try {
      const result = await runSocks5EchoProbe({
        ...proxyOptions(observer),
        targetHost: "127.0.0.1",
        targetPort: echo.port,
        addressType: "ip",
      });

      expect(result.addressType).toBe("ipv4");
      expect(observations).toContainEqual(
        expect.objectContaining({ phase: "request", addressType: "ipv4" }),
      );
    } finally {
      await observer.close();
      await echo.close();
    }
  });

  it("rejects invalid credentials without emitting their values", async () => {
    const observations: SocksObservation[] = [];
    const observer = await observerForTest(observations);
    try {
      await expect(
        runSocks5EchoProbe({
          ...proxyOptions(observer),
          password: "wrong-password",
          targetHost: "127.0.0.1",
          targetPort: 443,
          addressType: "ip",
        }),
      ).rejects.toThrow("SOCKS_AUTHENTICATION_FAILED");
      expect(observations).toContainEqual(
        expect.objectContaining({ phase: "rejected", errorCode: "AUTHENTICATION_FAILED" }),
      );
      expect(JSON.stringify(observations)).not.toContain("wrong-password");
    } finally {
      await observer.close();
    }
  });

  it("blocks private targets unless the local-test switch is explicit", async () => {
    const observations: SocksObservation[] = [];
    const observer = await startSocks5Observer({
      host: "127.0.0.1",
      port: 0,
      username: USERNAME,
      password: PASSWORD,
      onObservation: (observation) => observations.push(observation),
    });
    try {
      await expect(
        runSocks5EchoProbe({
          ...proxyOptions(observer),
          targetHost: "127.0.0.1",
          targetPort: 443,
          addressType: "ip",
        }),
      ).rejects.toThrow("SOCKS_CONNECT_FAILED_2");
      expect(observations).toContainEqual(
        expect.objectContaining({ phase: "rejected", errorCode: "PRIVATE_TARGET_BLOCKED" }),
      );
    } finally {
      await observer.close();
    }
  });

  it("can inject a deterministic disconnect for SDK recovery tests", async () => {
    const target = createServer(() => undefined);
    const targetPort = await listen(target);
    const observations: SocksObservation[] = [];
    const observer = await startSocks5Observer({
      host: "127.0.0.1",
      port: 0,
      username: USERNAME,
      password: PASSWORD,
      allowPrivateTargets: true,
      dropAfterMs: 30,
      onObservation: (observation) => observations.push(observation),
    });
    try {
      const tunnel = await openSocks5Tunnel({
        ...proxyOptions(observer),
        targetHost: "127.0.0.1",
        targetPort,
        addressType: "ip",
      });
      await new Promise<void>((resolve) => tunnel.once("close", () => resolve()));

      expect(observations).toContainEqual(
        expect.objectContaining({ phase: "injected_disconnect" }),
      );
    } finally {
      await observer.close();
      await close(target);
    }
  });
});

function observerForTest(observations: SocksObservation[]): Promise<RunningSocks5Observer> {
  return startSocks5Observer({
    host: "127.0.0.1",
    port: 0,
    username: USERNAME,
    password: PASSWORD,
    allowPrivateTargets: true,
    onObservation: (observation) => observations.push(observation),
  });
}

function proxyOptions(observer: RunningSocks5Observer) {
  return {
    proxyHost: "127.0.0.1",
    proxyPort: observer.port,
    username: USERNAME,
    password: PASSWORD,
  } as const;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("TARGET_ADDRESS_UNAVAILABLE"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
