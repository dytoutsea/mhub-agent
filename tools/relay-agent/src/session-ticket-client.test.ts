import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SessionTicketClient } from "./session-ticket-client.js";

describe("session ticket client", () => {
  it("signs the server canonical request and parses a ticket response", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    let request: Request | undefined;
    const client = new SessionTicketClient({
      apiUrl: "https://mhub.example.test/agent-api/v1/session-tickets",
      credentialId: "cpc_01K1D1NJ000000000000008003",
      devicePrivateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
      now: () => Date.parse("2026-08-12T02:00:00Z"),
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return new Response(
          JSON.stringify({ ticket: "signed-ticket", expires_at: "2026-08-12T02:05:00Z" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(client.issue()).resolves.toEqual({
      ticket: "signed-ticket",
      expiresAt: "2026-08-12T02:05:00Z",
    });
    expect(request).toBeDefined();
    const timestamp = request?.headers.get("X-Timestamp") ?? "";
    const nonce = request?.headers.get("X-Nonce") ?? "";
    const signature = request?.headers.get("X-Signature") ?? "";
    const canonical = [
      "POST",
      "/agent-api/v1/session-tickets",
      "",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "cpc_01K1D1NJ000000000000008003",
      timestamp,
      nonce,
    ].join("\n");
    expect(
      verify(null, Buffer.from(canonical), publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });

  it("fails closed on malformed key, response, and server errors", async () => {
    expect(
      () =>
        new SessionTicketClient({
          apiUrl: "https://mhub.example.test/agent-api/v1/session-tickets",
          credentialId: "cpc_01K1D1NJ000000000000008003",
          devicePrivateKey: "not-a-key",
        }),
    ).toThrow("DEVICE_PRIVATE_KEY_INVALID");

    const { privateKey } = generateKeyPairSync("ed25519");
    const base = {
      apiUrl: "https://mhub.example.test/agent-api/v1/session-tickets",
      credentialId: "cpc_01K1D1NJ000000000000008003",
      devicePrivateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    };
    const invalidResponse = new SessionTicketClient({
      ...base,
      fetchImpl: async () => new Response(JSON.stringify({ ticket: "" }), { status: 200 }),
    });
    await expect(invalidResponse.issue()).rejects.toThrow("SESSION_TICKET_RESPONSE_INVALID");

    const failedRequest = new SessionTicketClient({
      ...base,
      fetchImpl: async () => new Response("", { status: 503 }),
    });
    await expect(failedRequest.issue()).rejects.toThrow("SESSION_TICKET_REQUEST_FAILED_503");
  });
});
