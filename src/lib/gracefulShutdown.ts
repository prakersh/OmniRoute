/**
 * Graceful Shutdown — E-2 Critical Fix
 *
 * Handles SIGTERM / SIGINT to drain in-flight requests before exit.
 * Critical for Docker containers and Kubernetes pods where hard kills
 * can drop active SSE streams.
 *
 * Usage:
 *   import { initGracefulShutdown } from "@/lib/gracefulShutdown";
 *   initGracefulShutdown();
 *
 * @module lib/gracefulShutdown
 */

/** Whether we are currently shutting down */
let isShuttingDown = false;

/** Number of in-flight requests being tracked */
let activeRequests = 0;

/** Grace period before forced exit (default 30s, configurable) */
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || "30000", 10);

/**
 * Check if the server is currently shutting down.
 * Route handlers can use this to reject new requests.
 */
export function isDraining(): boolean {
  return isShuttingDown;
}

/**
 * Track a new in-flight request. Call `done()` when it completes.
 * Returns a done callback.
 */
export function trackRequest(): () => void {
  activeRequests++;
  let called = false;
  return () => {
    if (!called) {
      called = true;
      activeRequests--;
    }
  };
}

/**
 * Get current active request count (for monitoring/health endpoints).
 */
export function getActiveRequestCount(): number {
  return activeRequests;
}

/**
 * Wait for all in-flight requests to complete, with timeout.
 */
async function waitForDrain(): Promise<void> {
  const start = Date.now();
  const CHECK_INTERVAL_MS = 250;

  return new Promise((resolve) => {
    const check = () => {
      if (activeRequests <= 0) {
        console.log("[Shutdown] All in-flight requests drained.");
        resolve();
        return;
      }

      if (Date.now() - start > SHUTDOWN_TIMEOUT_MS) {
        console.warn(
          `[Shutdown] Timeout after ${SHUTDOWN_TIMEOUT_MS}ms with ${activeRequests} active requests. Forcing exit.`
        );
        resolve();
        return;
      }

      console.log(`[Shutdown] Waiting for ${activeRequests} in-flight request(s)...`);
      setTimeout(check, CHECK_INTERVAL_MS);
    };

    check();
  });
}

/**
 * Perform cleanup: close DB connections, flush logs.
 */
async function cleanup(): Promise<void> {
  try {
    // Close SQLite database — import dynamically to avoid circular deps
    const { getDbInstance } = await import("@/lib/db/core");
    const db = getDbInstance();
    if (db && typeof db.close === "function") {
      db.close();
      console.log("[Shutdown] SQLite database closed.");
    }
  } catch (err) {
    console.error("[Shutdown] Error during cleanup:", (err as Error).message);
  }
}

/**
 * Initialize graceful shutdown handlers.
 * Should be called once during server startup.
 */
export function initGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return; // Prevent double-shutdown
    isShuttingDown = true;

    console.log(`\n[Shutdown] Received ${signal}. Draining ${activeRequests} request(s)...`);

    await waitForDrain();
    await cleanup();

    console.log("[Shutdown] Bye.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log("[Shutdown] Graceful shutdown handlers registered.");
}
