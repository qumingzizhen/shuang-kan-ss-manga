"use client";

import { useEffect } from "react";

/**
 * Registers the reader image service worker. It caches online-reader page
 * images in the browser (stale-while-revalidate) so revisits are instant and
 * reader_retry requests bypass the cache.
 */
export function ReaderServiceWorker() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker
      .register("/service-worker.js")
      .catch((error: unknown) => {
        console.error(
          `reader service worker registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, []);

  return null;
}
