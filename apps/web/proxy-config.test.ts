import { describe, expect, it } from "vitest";

import {
  createApiRewrite,
  resolveBackendApiUrl,
  resolveBackendProxyTimeoutMs,
} from "./proxy-config";

describe("reverse proxy configuration", () => {
  it("defaults to the local backend and preserves the complete v1 path", () => {
    expect(resolveBackendApiUrl("")).toBe("http://127.0.0.1:8080");
    expect(createApiRewrite("http://127.0.0.1:8080")).toEqual({
      source: "/v1/:path*",
      destination: "http://127.0.0.1:8080/v1/:path*",
    });
  });

  it("normalizes a remote backend base path", () => {
    const backendApiUrl = resolveBackendApiUrl("https://api.example.test/manga///");
    expect(backendApiUrl).toBe("https://api.example.test/manga");
    expect(createApiRewrite(backendApiUrl).destination).toBe(
      "https://api.example.test/manga/v1/:path*",
    );
  });

  it.each([
    "ftp://api.example.test",
    "http://user:secret@localhost",
    "http://api.example.test/?token=secret",
    "not-an-url",
  ])("rejects unsafe or invalid backend URL %s", (value) => {
    expect(() => resolveBackendApiUrl(value)).toThrow();
  });

  it("uses a bounded configurable proxy timeout", () => {
    expect(resolveBackendProxyTimeoutMs("")).toBe(900_000);
    expect(resolveBackendProxyTimeoutMs("120000")).toBe(120_000);
    expect(() => resolveBackendProxyTimeoutMs("999")).toThrow();
    expect(() => resolveBackendProxyTimeoutMs("not-a-number")).toThrow();
  });
});
