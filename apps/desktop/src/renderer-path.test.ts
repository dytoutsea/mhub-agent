import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveRendererPath } from "./renderer-path";

const ROOT = path.resolve("/application/renderer");

describe("resolveRendererPath", () => {
  it("maps root and static asset paths inside the renderer directory", () => {
    expect(resolveRendererPath(ROOT, "mhub://renderer/")).toBe(path.join(ROOT, "index.html"));
    expect(resolveRendererPath(ROOT, "mhub://renderer/_expo/static/app.js")).toBe(
      path.join(ROOT, "_expo/static/app.js"),
    );
  });

  it("rejects other schemes and hosts", () => {
    expect(resolveRendererPath(ROOT, "https://renderer/index.html")).toBeNull();
    expect(resolveRendererPath(ROOT, "mhub://credentials/index.html")).toBeNull();
  });

  it("rejects encoded traversal and malformed paths", () => {
    expect(resolveRendererPath(ROOT, "mhub://renderer/%2e%2e%2fsecret")).toBeNull();
    expect(resolveRendererPath(ROOT, "mhub://renderer/%E0%A4%A")).toBeNull();
  });
});
