import { describe, expect, it } from "vitest";

import { parseMobilePublicConfiguration } from "./mobile-public-configuration";

describe("mobile public configuration", () => {
  it("accepts only the public HTTPS Agent API and WSS Relay endpoints", () => {
    expect(
      parseMobilePublicConfiguration(
        " https://api.example/agent-api/v1/activations:exchange ",
        " wss://relay.example/agent/v1/control ",
      ),
    ).toEqual({
      activationApiUrl: "https://api.example/agent-api/v1/activations:exchange",
      controlUrl: "wss://relay.example/agent/v1/control",
    });
  });

  it.each([
    [undefined, "wss://relay.example/agent/v1/control"],
    ["not-a-url", "wss://relay.example/agent/v1/control"],
    [
      "http://api.example/agent-api/v1/activations:exchange",
      "wss://relay.example/agent/v1/control",
    ],
    ["https://api.example/agent-api/v1/other", "wss://relay.example/agent/v1/control"],
    [
      "https://api.example/agent-api/v1/activations:exchange",
      "ws://relay.example/agent/v1/control",
    ],
    ["https://api.example/agent-api/v1/activations:exchange", "wss://relay.example/other"],
  ])("fails closed for missing or invalid endpoint configuration", (activation, control) => {
    expect(parseMobilePublicConfiguration(activation, control)).toBeNull();
  });
});
