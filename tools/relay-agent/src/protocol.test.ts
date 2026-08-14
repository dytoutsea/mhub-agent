import { describe, expect, it } from "vitest";

import { hello, parseDataAccepted, parseRelayMessage } from "./protocol.js";

describe("relay protocol v1", () => {
  it("creates the required IP-egress hello", () => {
    expect(hello("cpx_example", "ticket-value")).toEqual({
      type: "HELLO",
      protocol_version: 1,
      proxy_id: "cpx_example",
      ticket: "ticket-value",
      agent_version: "0.1.0",
      platform: "node",
      capabilities: ["tcp", "ip_egress", "per_stream_wss"],
    });
  });

  it("parses an open request", () => {
    expect(
      parseRelayMessage(
        JSON.stringify({
          type: "OPEN_REQUEST",
          connection_id: "rcn_example",
          connection_token: "0123456789abcdef0123456789abcdef",
          host: "8.8.8.8",
          port: 443,
          connect_timeout_ms: 5_000,
        }),
      ),
    ).toMatchObject({ type: "OPEN_REQUEST", host: "8.8.8.8", port: 443 });
  });

  it("rejects malformed messages and mismatched data pairing", () => {
    expect(() => parseRelayMessage('{"type":"OPEN_REQUEST"}')).toThrow();
    expect(() => parseRelayMessage('{"type":"PING","nonce":"ok","ticket":"unexpected"}')).toThrow(
      "RELAY_UNEXPECTED_FIELDS",
    );
    expect(() =>
      parseDataAccepted('{"type":"DATA_ACCEPTED","connection_id":"rcn_other"}', "rcn_expected"),
    ).toThrow("DATA_PAIRING_REJECTED");
  });

  it("parses the relay heartbeat response", () => {
    expect(parseRelayMessage('{"type":"PONG","nonce":"heartbeat-1"}')).toEqual({
      type: "PONG",
      nonce: "heartbeat-1",
    });
  });
});
