// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReaderServiceWorker } from "@/components/reader-service-worker";

const swPath = resolve(__dirname, "../../public/service-worker.js");
const sw = readFileSync(swPath, "utf8");

describe("reader service worker contract", () => {
  it("intercepts only same-origin reader page image requests", () => {
    expect(sw).toMatch(/READER_PAGE_PATH_PATTERN\s*=\s*\/\^\\\/v1\\\/reader\\\/sessions/);
    expect(sw).toContain("url.origin !== self.location.origin");
    expect(sw).toContain('request.method !== "GET"');
  });

  it("serves cached images and refreshes them in the background", () => {
    expect(sw).toContain("event.waitUntil(");
    expect(sw).toMatch(/cache\.match\(request\)/);
    expect(sw).toMatch(/cache\.put\(request, fresh\.clone\(\)\)/);
  });

  it("bypasses the cache for reader_retry and refresh requests", () => {
    expect(sw).toContain("reader_retry");
    expect(sw).toContain('url.searchParams.get("refresh") === "1"');
    expect(sw).toMatch(/cache\.delete\(request\)/);
  });

  it("bounds the cache size and supports explicit clearing", () => {
    expect(sw).toContain("READER_CACHE_MAX_ENTRIES");
    expect(sw).toContain('"clear-reader-cache"');
  });
});

describe("ReaderServiceWorker", () => {
  it("registers the worker on mount and renders nothing", async () => {
    const register = vi.fn().mockResolvedValue({});
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register },
      configurable: true,
    });
    const { container } = render(<ReaderServiceWorker />);
    expect(container).toBeEmptyDOMElement();
    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith("/service-worker.js");
    });
  });

  it("does not crash when service workers are unsupported", () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    const { container } = render(<ReaderServiceWorker />);
    expect(container).toBeEmptyDOMElement();
  });
});
