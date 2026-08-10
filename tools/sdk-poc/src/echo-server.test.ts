import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect as connectTcp, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startEchoServer } from "./echo-server.js";

const execFileAsync = promisify(execFile);
let certificateDirectory: string;
let certificate: Buffer;
let privateKey: Buffer;

beforeAll(async () => {
  certificateDirectory = await mkdtemp(path.join(tmpdir(), "mhub-sdk-poc-tls-"));
  const certificateFile = path.join(certificateDirectory, "localhost.crt");
  const keyFile = path.join(certificateDirectory, "localhost.key");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    keyFile,
    "-out",
    certificateFile,
  ]);
  [certificate, privateKey] = await Promise.all([readFile(certificateFile), readFile(keyFile)]);
});

afterAll(async () => {
  await rm(certificateDirectory, { recursive: true, force: true });
});

describe("echo server", () => {
  it("returns the observed address over TCP without reflecting arbitrary payload", async () => {
    const server = await startEchoServer({ host: "127.0.0.1", port: 0, transport: "tcp" });
    try {
      const socket = await openTcp(server.port);
      const response = await requestEcho(socket, "tcp-nonce");

      expect(response).toMatchObject({
        protocol: "mhub-poc-echo-v1",
        transport: "tcp",
        nonce: "tcp-nonce",
        observed_remote_address: "127.0.0.1",
      });
      expect(JSON.stringify(response)).not.toContain("arbitrary-payload");
    } finally {
      await server.close();
    }
  });

  it("supports TLS with an ephemeral certificate", async () => {
    const server = await startEchoServer({
      host: "127.0.0.1",
      port: 0,
      transport: "tls",
      tls: { cert: certificate, key: privateKey },
    });
    try {
      const socket = await openTls(server.port);
      const response = await requestEcho(socket, "tls-nonce");

      expect(response).toMatchObject({
        protocol: "mhub-poc-echo-v1",
        transport: "tls",
        nonce: "tls-nonce",
      });
    } finally {
      await server.close();
    }
  });
});

function openTcp(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function openTls(port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connectTls({
      host: "127.0.0.1",
      port,
      servername: "localhost",
      ca: certificate,
      rejectUnauthorized: true,
    });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function requestEcho(socket: Socket | TLSSocket, nonce: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
    });
    socket.once("end", () => {
      try {
        resolve(JSON.parse(buffer.toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
    socket.write(`${JSON.stringify({ nonce, ignored: "arbitrary-payload" })}\n`);
  });
}
