/**
 * Quota Cache — Domain Layer
 *
 * In-memory cache of provider quota data per connectionId.
 * Populated by:
 *   - Dashboard usage endpoint (GET /api/usage/[connectionId])
 *   - 429 responses marking account as exhausted
 *
 * Background refresh runs every 1 minute:
 *   - Active accounts (quota > 0%): refetch every 5 minutes
 *   - Exhausted accounts: refetch every 5 minutes (or immediately after resetAt passes)
 *
 * @module domain/quotaCache
 */

import { getUsageForProvider } from "@omniroute/open-sse/services/usage.ts";
import { getProviderConnectionById, resolveProxyForConnection } from "@/lib/localDb";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { safePercentage } from "@/shared/utils/formatting";

// ─── Types ──────────────────────────────────────────────────────────────────

interface QuotaInfo {
  remainingPercentage: number;
  resetAt: string | null;
}

interface QuotaCacheEntry {
  connectionId: string;
  provider: string;
  quotas: Record<string, QuotaInfo>;
  fetchedAt: number;
  exhausted: boolean;
  nextResetAt: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ACTIVE_TTL_MS = 5 * 60 * 1000; // 5 minutes for active accounts
const EXHAUSTED_TTL_MS = 5 * 60 * 1000; // 5 minutes for 429-sourced entries (no resetAt)
const EXHAUSTED_REFRESH_MS = 5 * 60 * 1000; // 5 minutes: recheck exhausted accounts (aligned with TTL)
const REFRESH_INTERVAL_MS = 60 * 1000; // Background tick every 1 minute

// ─── State ──────────────────────────────────────────────────────────────────

const cache = new Map<string, QuotaCacheEntry>();
const MAX_CONCURRENT_REFRESHES = 5;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

function isExhausted(quotas: Record<string, QuotaInfo>): boolean {
  const entries = Object.values(quotas);
  if (entries.length === 0) return false;
  return entries.every((q) => q.remainingPercentage <= 0);
}

function parseDate(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function earliestResetAt(quotas: Record<string, QuotaInfo>): string | null {
  let earliest: string | null = null;
  let earliestMs = Infinity;
  for (const q of Object.values(quotas)) {
    if (!q.resetAt) continue;
    const ms = parseDate(q.resetAt);
    if (ms !== null && ms < earliestMs) {
      earliestMs = ms;
      earliest = q.resetAt;
    }
  }
  return earliest;
}

function normalizeQuotas(rawQuotas: Record<string, any>): Record<string, QuotaInfo> {
  const result: Record<string, QuotaInfo> = {};
  for (const [key, q] of Object.entries(rawQuotas)) {
    if (q && typeof q === "object") {
      result[key] = {
        remainingPercentage:
          safePercentage(q.remainingPercentage) ??
          (q.total > 0 ? Math.round(((q.total - (q.used || 0)) / q.total) * 100) : 0),
        resetAt: q.resetAt || null,
      };
    }
  }
  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Store quota data for a connection (called by usage endpoint and background refresh).
 */
export function setQuotaCache(
  connectionId: string,
  provider: string,
  rawQuotas: Record<string, any>
) {
  const quotas = normalizeQuotas(rawQuotas);
  const exhausted = isExhausted(quotas);
  cache.set(connectionId, {
    connectionId,
    provider,
    quotas,
    fetchedAt: Date.now(),
    exhausted,
    nextResetAt: exhausted ? earliestResetAt(quotas) : null,
  });
}

/**
 * Get cached quota entry (returns null if not cached).
 */
export function getQuotaCache(connectionId: string): QuotaCacheEntry | null {
  return cache.get(connectionId) || null;
}

/**
 * Check if an account's quota is exhausted based on cached data.
 * Returns false if no cache entry exists (unknown = assume available).
 */
export function isAccountQuotaExhausted(connectionId: string): boolean {
  const entry = cache.get(connectionId);
  if (!entry) return false;
  if (!entry.exhausted) return false;

  // If resetAt has passed, assume available until refresh confirms
  if (entry.nextResetAt) {
    const resetMs = parseDate(entry.nextResetAt);
    if (resetMs !== null && resetMs <= Date.now()) return false;
  }

  // Exhausted entries without resetAt expire after fixed TTL
  const age = Date.now() - entry.fetchedAt;
  if (!entry.nextResetAt && age > EXHAUSTED_TTL_MS) return false;

  return true;
}

/**
 * Mark an account as quota-exhausted from a 429 response (no quota data available).
 * Uses 5-minute fixed TTL since we don't know the actual resetAt.
 */
export function markAccountExhaustedFrom429(connectionId: string, provider: string) {
  cache.set(connectionId, {
    connectionId,
    provider,
    quotas: {},
    fetchedAt: Date.now(),
    exhausted: true,
    nextResetAt: null,
  });
}

// ─── Background Refresh ─────────────────────────────────────────────────────

const refreshingSet = new Set<string>();

async function refreshEntry(entry: QuotaCacheEntry) {
  if (refreshingSet.has(entry.connectionId)) return;
  refreshingSet.add(entry.connectionId);

  try {
    const connection = await getProviderConnectionById(entry.connectionId);
    if (!connection || connection.authType !== "oauth" || !connection.isActive) {
      cache.delete(entry.connectionId);
      return;
    }

    const proxyInfo = await resolveProxyForConnection(entry.connectionId);
    const usage = await runWithProxyContext(proxyInfo?.proxy || null, () =>
      getUsageForProvider(connection)
    );

    if (usage?.quotas) {
      setQuotaCache(entry.connectionId, entry.provider, usage.quotas);
    }
  } catch (err) {
    console.warn(
      `[QuotaCache] Refresh failed for ${entry.connectionId.slice(0, 8)}:`,
      (err as any)?.message || err
    );
  } finally {
    refreshingSet.delete(entry.connectionId);
  }
}

function needsRefresh(entry: QuotaCacheEntry, now: number): boolean {
  const age = now - entry.fetchedAt;
  if (entry.exhausted) {
    if (entry.nextResetAt) {
      const resetMs = parseDate(entry.nextResetAt);
      if (resetMs !== null && resetMs <= now) return true;
    }
    return age >= EXHAUSTED_REFRESH_MS;
  }
  return age >= ACTIVE_TTL_MS;
}

async function backgroundRefreshTick() {
  if (tickRunning) return;
  tickRunning = true;

  try {
    const now = Date.now();
    const pending = [...cache.values()].filter((e) => needsRefresh(e, now));

    // Refresh in batches to avoid thundering herd
    for (let i = 0; i < pending.length; i += MAX_CONCURRENT_REFRESHES) {
      const batch = pending.slice(i, i + MAX_CONCURRENT_REFRESHES);
      await Promise.allSettled(batch.map(refreshEntry));
    }
  } finally {
    tickRunning = false;
  }
}

/**
 * Start the background refresh timer.
 */
export function startBackgroundRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(backgroundRefreshTick, REFRESH_INTERVAL_MS);
  refreshTimer?.unref?.();
}

/**
 * Stop the background refresh timer.
 */
export function stopBackgroundRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Get cache stats (for debugging/dashboard).
 */
export function getQuotaCacheStats() {
  const entries: Array<{
    connectionId: string;
    provider: string;
    exhausted: boolean;
    nextResetAt: string | null;
    ageMs: number;
  }> = [];

  for (const entry of cache.values()) {
    entries.push({
      connectionId: entry.connectionId.slice(0, 8) + "...",
      provider: entry.provider,
      exhausted: entry.exhausted,
      nextResetAt: entry.nextResetAt,
      ageMs: Date.now() - entry.fetchedAt,
    });
  }

  return { total: cache.size, entries };
}
