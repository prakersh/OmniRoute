/**
 * Background Task Detector — Feature 3
 *
 * Detects when CLI tools send "background" requests (title generation,
 * summarization, short descriptions) and provides model degradation
 * recommendations to save premium model quota.
 *
 * Detection heuristics:
 * - System prompt patterns indicating background/utility tasks
 * - Very short conversations with summary-like system prompts
 * - X-Request-Priority header
 */

// ── Configuration ───────────────────────────────────────────────────────────

interface DegradationConfig {
  enabled: boolean;
  degradationMap: Record<string, string>; // original → cheaper model
  detectionPatterns: string[]; // regex patterns for system prompt matching
  stats: {
    detected: number;
    tokensSaved: number;
  };
}

const DEFAULT_DETECTION_PATTERNS = [
  "generate a title",
  "generate title",
  "create a title",
  "create a short",
  "summarize this",
  "summarize the",
  "write a brief",
  "write a summary",
  "one-line summary",
  "one line summary",
  "short description",
  "brief description",
  "conversation title",
  "chat title",
  "name this conversation",
  "name this chat",
  "title for this",
  "suggest a title",
  "label this",
];

const DEFAULT_DEGRADATION_MAP: Record<string, string> = {
  // Premium → Cheap alternatives
  "claude-opus-4-6": "gemini-2.5-flash",
  "claude-opus-4-6-thinking": "gemini-2.5-flash",
  "claude-opus-4-5-20251101": "gemini-2.5-flash",
  "claude-sonnet-4-5-20250929": "gemini-2.5-flash",
  "claude-sonnet-4-20250514": "gemini-2.5-flash",
  "claude-sonnet-4": "gemini-2.5-flash",
  "gemini-3.1-pro": "gemini-3.1-flash",
  "gemini-3.1-pro-high": "gemini-3.1-flash",
  "gemini-3-pro-preview": "gemini-3-flash-preview",
  "gemini-2.5-pro": "gemini-2.5-flash",
  "gpt-4o": "gpt-4o-mini",
  "gpt-5": "gpt-5-mini",
  "gpt-5.1": "gpt-5-mini",
  "gpt-5.1-codex": "gpt-5.1-codex-mini",
};

// ── State ───────────────────────────────────────────────────────────────────

let _config: DegradationConfig = {
  enabled: false, // Disabled by default — user must opt in
  degradationMap: { ...DEFAULT_DEGRADATION_MAP },
  detectionPatterns: [...DEFAULT_DETECTION_PATTERNS],
  stats: { detected: 0, tokensSaved: 0 },
};

// ── Config Management ───────────────────────────────────────────────────────

/**
 * Set the background degradation config (called from settings API or startup).
 */
export function setBackgroundDegradationConfig(config: Partial<DegradationConfig>): void {
  _config = {
    ..._config,
    ...config,
    stats: _config.stats, // preserve stats across config changes
  };
}

/**
 * Get current background degradation config.
 */
export function getBackgroundDegradationConfig(): DegradationConfig {
  return {
    ..._config,
    degradationMap: { ..._config.degradationMap },
    detectionPatterns: [..._config.detectionPatterns],
    stats: { ..._config.stats },
  };
}

/**
 * Reset stats counters.
 */
export function resetStats(): void {
  _config.stats = { detected: 0, tokensSaved: 0 };
}

// ── Detection ───────────────────────────────────────────────────────────────

interface BackgroundMessage {
  role?: string;
  content?: unknown;
}

interface BackgroundTaskBody {
  messages?: BackgroundMessage[];
  input?: BackgroundMessage[];
}

function toMessageArray(value: unknown): BackgroundMessage[] {
  return Array.isArray(value) ? (value as BackgroundMessage[]) : [];
}

/**
 * Check if a request is a background/utility task.
 *
 * @param {object} body - Request body
 * @param {object} [headers] - Request headers (optional)
 * @returns {boolean} True if the request looks like a background task
 */
export function isBackgroundTask(
  body: BackgroundTaskBody | unknown,
  headers: Record<string, string> | null = null
): boolean {
  if (!body || typeof body !== "object") return false;
  const typedBody = body as BackgroundTaskBody;

  // 1. Check explicit header
  if (headers) {
    const priority =
      headers["x-request-priority"] || headers["X-Request-Priority"] || headers["x-initiator"];
    if (priority === "background" || priority === "Background") return true;
  }

  // 2. Check system prompt for background task patterns
  const messages = toMessageArray(typedBody.messages ?? typedBody.input ?? []);
  if (!Array.isArray(messages) || messages.length === 0) return false;

  // Find system message
  const systemMsg = messages.find(
    (message: BackgroundMessage) => message.role === "system" || message.role === "developer"
  );
  if (!systemMsg) return false;

  const systemContent =
    typeof systemMsg.content === "string" ? systemMsg.content.toLowerCase() : "";

  if (!systemContent) return false;

  // Check against detection patterns
  const matched = _config.detectionPatterns.some((pattern) =>
    systemContent.includes(pattern.toLowerCase())
  );

  if (!matched) return false;

  // 3. Additional heuristic: background tasks typically have very few messages
  // (system + 1-2 user messages)
  const userMessages = messages.filter((message: BackgroundMessage) => message.role === "user");
  if (userMessages.length > 3) return false; // Too many turns for a background task

  return true;
}

/**
 * Get the degraded (cheaper) model for a given model.
 *
 * @param {string} originalModel - The original model ID
 * @returns {string} The cheaper model or original if no mapping exists
 */
export function getDegradedModel(originalModel: string): string {
  if (!originalModel) return originalModel;

  const degraded = _config.degradationMap[originalModel];
  if (degraded) {
    _config.stats.detected++;
    return degraded;
  }

  return originalModel;
}

/**
 * Get default degradation map (for UI reset).
 */
export function getDefaultDegradationMap(): Record<string, string> {
  return { ...DEFAULT_DEGRADATION_MAP };
}

/**
 * Get default detection patterns (for UI reset).
 */
export function getDefaultDetectionPatterns(): string[] {
  return [...DEFAULT_DETECTION_PATTERNS];
}
