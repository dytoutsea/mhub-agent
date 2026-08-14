import { describe, expect, it } from "vitest";

import { hello, parseDataAccepted, parseRelayMessage } from "./index";

describe("relay protocol v1", () => {
  it("creates platform-specific IP-egress hello messages", () => {
    expect(hello("cpx_example", "ticket-value", "android")).toEqual({
      type: "HELLO",
      protocol_version: 1,
      proxy_id: "cpx_example",
      ticket: "ticket-value",
      agent_version: "0.1.0",
      platform: "android",
      capabilities: ["tcp", "ip_egress", "per_stream_wss"],
    });
  });

  it("strictly parses relay messages and IP-literal targets", () => {
    expect(
      parseRelayMessage(
        JSON.stringify({
          type: "OPEN_REQUEST",
          connection_id: "rcn_example",
          connection_token: "0123456789abcdef0123456789abcdef",
          host: "2606:4700:4700::1111",
          port: 443,
          connect_timeout_ms: 5_000,
        }),
      ),
    ).toMatchObject({ type: "OPEN_REQUEST", host: "2606:4700:4700::1111", port: 443 });

    expect(() =>
      parseRelayMessage(
        JSON.stringify({
          type: "OPEN_REQUEST",
          connection_id: "rcn_example",
          connection_token: "0123456789abcdef0123456789abcdef",
          host: "example.com",
          port: 443,
          connect_timeout_ms: 5_000,
        }),
      ),
    ).toThrow("RELAY_HOST_INVALID");

    for (const host of ["1.2.3", "192.168.001.1", "fe80::1%en0"]) {
      expect(() =>
        parseRelayMessage(
          JSON.stringify({
            type: "OPEN_REQUEST",
            connection_id: "rcn_example",
            connection_token: "0123456789abcdef0123456789abcdef",
            host,
            port: 443,
            connect_timeout_ms: 5_000,
          }),
        ),
      ).toThrow("RELAY_HOST_INVALID");
    }
  });

  it("rejects malformed messages and mismatched data pairing", () => {
    expect(() => parseRelayMessage('{"type":"OPEN_REQUEST"}')).toThrow();
    expect(() => parseRelayMessage('{"type":"PING","nonce":"ok","extra":true}')).toThrow(
      "RELAY_UNEXPECTED_FIELDS",
    );
    expect(() =>
      parseDataAccepted('{"type":"DATA_ACCEPTED","connection_id":"other"}', "expected"),
    ).toThrow("DATA_PAIRING_REJECTED");
  });

  it("parses the relay heartbeat response", () => {
    expect(parseRelayMessage('{"type":"PONG","nonce":"heartbeat-1"}')).toEqual({
      type: "PONG",
      nonce: "heartbeat-1",
    });
  });
});
