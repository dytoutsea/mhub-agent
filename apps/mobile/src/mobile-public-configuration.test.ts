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
      allowInsecureDevelopmentEndpoints: false,
    });
  });

  it("accepts the controlled insecure development endpoints only in the dev channel", () => {
    expect(
      parseMobilePublicConfiguration(
        "http://8.138.121.25:8080/agent-api/v1/activations:exchange",
        "ws://8.138.121.25:8443/agent/v1/control",
        "dev",
      ),
    ).toEqual({
      activationApiUrl: "http://8.138.121.25:8080/agent-api/v1/activations:exchange",
      controlUrl: "ws://8.138.121.25:8443/agent/v1/control",
      allowInsecureDevelopmentEndpoints: true,
    });
    expect(
      parseMobilePublicConfiguration(
        "http://8.138.121.25:8080/agent-api/v1/activations:exchange",
        "ws://8.138.121.25:8443/agent/v1/control",
        "main",
      ),
    ).toBeNull();
  });

  it("rejects unsupported release channels and endpoint credentials", () => {
    expect(
      parseMobilePublicConfiguration(
        "https://api.example/agent-api/v1/activations:exchange",
        "wss://relay.example/agent/v1/control",
        "preview",
      ),
    ).toBeNull();
    expect(
      parseMobilePublicConfiguration(
        "https://user:pass@api.example/agent-api/v1/activations:exchange",
        "wss://relay.example/agent/v1/control",
        "main",
      ),
    ).toBeNull();
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
