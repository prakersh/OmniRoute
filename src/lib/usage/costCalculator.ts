/**
 * Cost Calculator — extracted from usageDb.js (T-15)
 *
 * Pure function for calculating request cost based on model pricing.
 * No DB interaction — pricing is fetched from localDb.
 *
 * @module lib/usage/costCalculator
 */

/**
 * Normalize model name — strip provider path prefixes.
 * Examples:
 *   "openai/gpt-oss-120b" → "gpt-oss-120b"
 *   "accounts/fireworks/models/gpt-oss-120b" → "gpt-oss-120b"
 *   "deepseek-ai/DeepSeek-R1" → "DeepSeek-R1"
 *   "gpt-oss-120b" → "gpt-oss-120b" (no-op)
 *
 * @param {string} model
 * @returns {string}
 */
function normalizeModelName(model) {
  if (!model || !model.includes("/")) return model;
  const parts = model.split("/");
  return parts[parts.length - 1];
}

// Default pricing per million tokens when no DB pricing is configured.
// Prices are approximate industry rates for cost estimation.
const DEFAULT_PRICING: Record<
  string,
  Record<string, { input: number; output: number; cached?: number }>
> = {
  codex: {
    "gpt-5.3-codex": { input: 2, output: 8 },
    "gpt-5.3-codex-high": { input: 2, output: 8 },
    "gpt-5.3-codex-xhigh": { input: 2, output: 8 },
  },
  claude: {
    "claude-opus-4-5-20251101": { input: 15, output: 75, cached: 1.5 },
    "claude-opus-4-6": { input: 15, output: 75, cached: 1.5 },
    "claude-sonnet-4-5-20250929": { input: 3, output: 15, cached: 0.3 },
    "claude-sonnet-4.5": { input: 3, output: 15, cached: 0.3 },
    "claude-sonnet-4.6": { input: 3, output: 15, cached: 0.3 },
  },
  // Boss/anthropic-compatible uses Claude pricing
  boss: {
    "claude-opus-4.6": { input: 15, output: 75, cached: 1.5 },
    "claude-opus-4-6": { input: 15, output: 75, cached: 1.5 },
    "claude-sonnet-4.5": { input: 3, output: 15, cached: 0.3 },
  },
  "anthropic-compatible": {
    "claude-opus-4.6": { input: 15, output: 75, cached: 1.5 },
    "claude-opus-4-6": { input: 15, output: 75, cached: 1.5 },
    "claude-sonnet-4.5": { input: 3, output: 15, cached: 0.3 },
  },
  minimax: {
    "MiniMax-M2.5": { input: 1, output: 4 },
    "MiniMax-M2.1": { input: 1, output: 4 },
  },
  kiro: {
    "claude-sonnet-4.5": { input: 3, output: 15, cached: 0.3 },
    "claude-sonnet-4-5-20250929": { input: 3, output: 15, cached: 0.3 },
  },
};

function getDefaultPricing(
  provider: string,
  model: string
): { input: number; output: number; cached?: number } | null {
  const normalizedProvider = provider?.toLowerCase?.() || "";
  // Direct match
  if (DEFAULT_PRICING[normalizedProvider]?.[model])
    return DEFAULT_PRICING[normalizedProvider][model];
  // Try with normalized model name
  const normalizedModel = normalizeModelName(model);
  if (DEFAULT_PRICING[normalizedProvider]?.[normalizedModel])
    return DEFAULT_PRICING[normalizedProvider][normalizedModel];
  // Try anthropic-compatible prefix match
  if (normalizedProvider.startsWith("anthropic-compatible")) {
    const ac = DEFAULT_PRICING["anthropic-compatible"];
    return ac?.[model] || ac?.[normalizedModel] || null;
  }
  return null;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Calculate cost for a usage entry.
 *
 * @param {string} provider
 * @param {string} model
 * @param {Object} tokens
 * @returns {Promise<number>} Cost in USD
 */
export async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;

  try {
    const { getPricingForModel } = await import("@/lib/localDb");

    // Try exact match first, then normalized model name
    let pricing = await getPricingForModel(provider, model);
    if (!pricing) {
      const normalized = normalizeModelName(model);
      if (normalized !== model) {
        pricing = await getPricingForModel(provider, normalized);
      }
    }
    // Fall back to default pricing if no DB pricing exists
    if (!pricing) {
      const defaultP = getDefaultPricing(provider, model);
      if (defaultP) {
        pricing = defaultP;
      } else {
        return 0;
      }
    }

    const pricingRecord =
      pricing && typeof pricing === "object" && !Array.isArray(pricing)
        ? (pricing as Record<string, unknown>)
        : {};
    const inputPrice = toNumber(pricingRecord.input, 0);
    const cachedPrice = toNumber(pricingRecord.cached, inputPrice);
    const outputPrice = toNumber(pricingRecord.output, 0);
    const reasoningPrice = toNumber(pricingRecord.reasoning, outputPrice);
    const cacheCreationPrice = toNumber(pricingRecord.cache_creation, inputPrice);

    let cost = 0;

    const inputTokens = tokens.input ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0;
    const cachedTokens =
      tokens.cacheRead ?? tokens.cached_tokens ?? tokens.cache_read_input_tokens ?? 0;
    const nonCachedInput = Math.max(0, inputTokens - cachedTokens);
    cost += nonCachedInput * (inputPrice / 1000000);

    if (cachedTokens > 0) {
      cost += cachedTokens * (cachedPrice / 1000000);
    }

    const outputTokens = tokens.output ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0;
    cost += outputTokens * (outputPrice / 1000000);

    const reasoningTokens = tokens.reasoning ?? tokens.reasoning_tokens ?? 0;
    if (reasoningTokens > 0) {
      cost += reasoningTokens * (reasoningPrice / 1000000);
    }

    const cacheCreationTokens = tokens.cacheCreation ?? tokens.cache_creation_input_tokens ?? 0;
    if (cacheCreationTokens > 0) {
      cost += cacheCreationTokens * (cacheCreationPrice / 1000000);
    }

    return cost;
  } catch (error) {
    console.error("Error calculating cost:", error);
    return 0;
  }
}
