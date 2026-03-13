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

function addCandidate(candidates: string[], candidate: unknown) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return;
  if (!candidates.includes(candidate)) candidates.push(candidate);
}

function buildPricingModelCandidates(model: string): string[] {
  const candidates: string[] = [];
  addCandidate(candidates, model);

  const normalized = normalizeModelName(model);
  addCandidate(candidates, normalized);

  const stripPrioritySuffix = (value: string) =>
    value.replace(/-(xhigh|high|medium|low|none)$/i, "");

  const withPriorityStripped = stripPrioritySuffix(normalized);
  addCandidate(candidates, withPriorityStripped);

  // Family-level fallback for new GPT-5 variants not yet in static pricing table.
  if (/^gpt-5\.\d+-codex/i.test(withPriorityStripped)) {
    addCandidate(candidates, "gpt-5.2-codex");
    addCandidate(candidates, "gpt-5-codex");
  } else if (/^gpt-5\.\d+/i.test(withPriorityStripped)) {
    addCandidate(candidates, "gpt-5.2");
  }

  return candidates;
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

    let pricing = null;
    for (const candidate of buildPricingModelCandidates(model)) {
      pricing = await getPricingForModel(provider, candidate);
      if (pricing) {
        break;
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
