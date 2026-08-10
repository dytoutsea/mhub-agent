import { describe, expect, it } from "vitest";

import { isAllowedTargetIp, sameIp } from "./address-policy.js";

describe("address policy", () => {
  it("accepts public IP literals", () => {
    expect(isAllowedTargetIp("8.8.8.8")).toBe(true);
    expect(isAllowedTargetIp("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects domains and non-public addresses by default", () => {
    expect(isAllowedTargetIp("example.com")).toBe(false);
    expect(isAllowedTargetIp("127.0.0.1")).toBe(false);
    expect(isAllowedTargetIp("10.0.0.1")).toBe(false);
    expect(isAllowedTargetIp("169.254.169.254")).toBe(false);
    expect(isAllowedTargetIp("::1")).toBe(false);
  });

  it("allows loopback only through the explicit development override", () => {
    expect(isAllowedTargetIp("127.0.0.1", true)).toBe(true);
  });

  it("compares normalized IPv4 and mapped IPv6 peers", () => {
    expect(sameIp("::ffff:127.0.0.1", "127.0.0.1")).toBe(true);
    expect(sameIp("127.0.0.2", "127.0.0.1")).toBe(false);
  });
});
