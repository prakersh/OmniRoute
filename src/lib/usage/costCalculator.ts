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

    // Fallback: for user-defined providers (anthropic-compatible-*, openai-compatible-*, etc.)
    // try to infer pricing from the model name by checking known provider pricing tables
    if (!pricing) {
      const modelLower = (model || "").toLowerCase();
      const fallbackProviders: string[] = [];
      if (modelLower.includes("claude") || modelLower.includes("minimax")) {
        fallbackProviders.push("anthropic", "minimax", "cc");
      } else if (modelLower.includes("gpt") || modelLower.includes("codex")) {
        fallbackProviders.push("openai", "cx");
      } else if (modelLower.includes("gemini")) {
        fallbackProviders.push("gemini", "gc");
      }
      for (const fp of fallbackProviders) {
        pricing = await getPricingForModel(fp, model);
        if (pricing) break;
        const normalized = normalizeModelName(model);
        if (normalized !== model) {
          pricing = await getPricingForModel(fp, normalized);
          if (pricing) break;
        }
      }
    }

    if (!pricing) return 0;

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
    const cacheCreationTokens = tokens.cacheCreation ?? tokens.cache_creation_input_tokens ?? 0;
    // nonCachedInput = total input minus cached reads and cache creation (each billed separately)
    const nonCachedInput = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);
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

    if (cacheCreationTokens > 0) {
      cost += cacheCreationTokens * (cacheCreationPrice / 1000000);
    }

    return cost;
  } catch (error) {
    console.error("Error calculating cost:", error);
    return 0;
  }
}
