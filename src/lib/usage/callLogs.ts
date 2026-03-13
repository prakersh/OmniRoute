/**
 * Call Logs — extracted from usageDb.js (T-15)
 *
 * Structured call log management: save, query, rotate, and
 * full-payload disk storage for the Logger UI.
 *
 * @module lib/usage/callLogs
 */

import path from "path";
import fs from "fs";
import { getDbInstance } from "../db/core";
import { shouldPersistToDisk, CALL_LOGS_DIR } from "./migrations";
import { isNoLog } from "../compliance";
import { sanitizePII } from "../piiSanitizer";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readTokenValue(container: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(container, key)) continue;
    const raw = container[key];
    if (raw === undefined || raw === null) continue;
    const numeric = toNumber(raw);
    if (Number.isFinite(numeric)) return numeric;
  }
  return undefined;
}

function normalizeTokenPair(rawTokens: unknown): { in: number; out: number } {
  const tokens = asRecord(rawTokens);
  const nestedUsage = asRecord(tokens.usage);

  const input =
    readTokenValue(tokens, [
      "in",
      "input",
      "prompt_tokens",
      "input_tokens",
      "promptTokens",
      "tokens_in",
    ]) ??
    readTokenValue(nestedUsage, [
      "in",
      "input",
      "prompt_tokens",
      "input_tokens",
      "promptTokens",
      "tokens_in",
    ]) ??
    0;

  const output =
    readTokenValue(tokens, [
      "out",
      "output",
      "completion_tokens",
      "output_tokens",
      "completionTokens",
      "tokens_out",
    ]) ??
    readTokenValue(nestedUsage, [
      "out",
      "output",
      "completion_tokens",
      "output_tokens",
      "completionTokens",
      "tokens_out",
    ]) ??
    0;

  return { in: input, out: output };
}

function extractTokensFromPayload(payload: unknown): { in: number; out: number } | null {
  const root = asRecord(payload);

  // OpenAI-like payloads: { usage: { prompt_tokens, completion_tokens } }
  const usage = asRecord(root.usage);
  if (Object.keys(usage).length > 0) {
    const pair = normalizeTokenPair(usage);
    if (pair.in > 0 || pair.out > 0) return pair;
  }

  // Responses payloads: { response: { usage: { input_tokens, output_tokens } } }
  const response = asRecord(root.response);
  const responseUsage = asRecord(response.usage);
  if (Object.keys(responseUsage).length > 0) {
    const pair = normalizeTokenPair(responseUsage);
    if (pair.in > 0 || pair.out > 0) return pair;
  }

  // Gemini payloads: { usageMetadata: { promptTokenCount, candidatesTokenCount } }
  const usageMetadata = asRecord(root.usageMetadata);
  if (Object.keys(usageMetadata).length > 0) {
    const inTokens = readTokenValue(usageMetadata, ["promptTokenCount"]) ?? 0;
    const outTokens = readTokenValue(usageMetadata, ["candidatesTokenCount"]) ?? 0;
    if (inTokens > 0 || outTokens > 0) return { in: inTokens, out: outTokens };
  }

  return null;
}

function estimateTokenCount(value: unknown): number {
  if (value === null || value === undefined) return 0;
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    if (!str) return 0;
    return Math.max(0, Math.ceil(str.length / 4));
  } catch {
    return 0;
  }
}

function estimateTokenPairFromBodies(
  requestBody: unknown,
  responseBody: unknown
): {
  in: number;
  out: number;
} {
  return {
    in: estimateTokenCount(requestBody),
    out: estimateTokenCount(responseBody),
  };
}

function mergeMissingTokenFields(
  base: { in: number; out: number },
  candidate: { in: number; out: number } | null
): { in: number; out: number } {
  if (!candidate) return base;
  return {
    in: base.in > 0 ? base.in : Math.max(0, candidate.in),
    out: base.out > 0 ? base.out : Math.max(0, candidate.out),
  };
}

function toIsoInWindow(centerIso: string | null, offsetMs: number): string | null {
  if (!centerIso) return null;
  const t = Date.parse(centerIso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + offsetMs).toISOString();
}

function parseJsonString(value: unknown): unknown | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasTruncatedFlag(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)._truncated === true;
}

const CALL_LOGS_MAX = parseInt(process.env.CALL_LOGS_MAX || "5000", 10);
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || "7", 10);
const CALL_LOG_PAYLOAD_MODE = (() => {
  const value = (process.env.CALL_LOG_PAYLOAD_MODE || "full").toLowerCase();
  return value === "full" || value === "metadata" || value === "none" ? value : "full";
})();
const shouldLogPayloadInDb = CALL_LOG_PAYLOAD_MODE !== "none";
const shouldLogPayloadOnDisk = CALL_LOG_PAYLOAD_MODE === "full";

/** Fields that should always be redacted from logged payloads */
const SENSITIVE_KEYS = new Set([
  "api_key",
  "apiKey",
  "api-key",
  "authorization",
  "Authorization",
  "x-api-key",
  "X-Api-Key",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "password",
  "secret",
  "token",
]);

/**
 * Redact sensitive fields from a payload before persistence.
 */
function redactPayload(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactPayload);

  const redacted: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.startsWith("Bearer ")) {
      redacted[key] = "Bearer [REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      redacted[key] = redactPayload(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Recursively sanitize PII from string fields in a payload.
 * Uses lib/piiSanitizer config flags to determine if redaction is enabled.
 */
function sanitizePayloadPII(obj: any): any {
  if (typeof obj === "string") {
    return sanitizePII(obj).text;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizePayloadPII);
  }
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    sanitized[key] = sanitizePayloadPII(value);
  }
  return sanitized;
}

/**
 * Apply payload protection chain before persistence.
 * 1) Optional PII sanitization
 * 2) Mandatory key/token redaction
 */
function protectPayloadForLog(payload: any): any {
  if (!payload || !shouldLogPayloadInDb) return null;
  const piiSanitized = sanitizePayloadPII(payload);
  return redactPayload(piiSanitized);
}

let logIdCounter = 0;
function generateLogId() {
  logIdCounter++;
  return `${Date.now()}-${logIdCounter}`;
}

/**
 * Save a structured call log entry.
 */
export async function saveCallLog(entry: any) {
  if (!shouldPersistToDisk) return;

  try {
    let normalizedTokens = normalizeTokenPair(entry.tokens ?? entry.usage);
    normalizedTokens = mergeMissingTokenFields(
      normalizedTokens,
      extractTokensFromPayload(entry.responseBody) || extractTokensFromPayload(entry.requestBody)
    );
    normalizedTokens = mergeMissingTokenFields(
      normalizedTokens,
      estimateTokenPairFromBodies(entry.requestBody, entry.responseBody)
    );
    const apiKeyId = entry.apiKeyId || null;
    const noLogEnabled = Boolean(entry.noLog) || (apiKeyId ? isNoLog(apiKeyId) : false);

    const protectedRequestBody = noLogEnabled ? null : protectPayloadForLog(entry.requestBody);
    const protectedResponseBody = noLogEnabled ? null : protectPayloadForLog(entry.responseBody);

    // Resolve account name
    let account = entry.connectionId ? entry.connectionId.slice(0, 8) : "-";
    try {
      const { getProviderConnections } = await import("@/lib/localDb");
      const connections = await getProviderConnections();
      const conn = connections.find((c) => c.id === entry.connectionId);
      if (conn) account = conn.name || conn.email || account;
    } catch {}

    // Truncate large payloads for DB storage (keep under 8KB each)
    const truncatePayload = (obj: any) => {
      if (!obj) return null;
      const str = JSON.stringify(obj);
      if (str.length <= 8192) return str;
      try {
        return JSON.stringify({
          _truncated: true,
          _originalSize: str.length,
          _preview: str.slice(0, 8192) + "...",
        });
      } catch {
        return JSON.stringify({ _truncated: true });
      }
    };

    const logEntry = {
      id: generateLogId(),
      timestamp: new Date().toISOString(),
      method: entry.method || "POST",
      path: entry.path || "/v1/chat/completions",
      status: entry.status || 0,
      model: entry.model || "-",
      provider: entry.provider || "-",
      account,
      connectionId: entry.connectionId || null,
      duration: entry.duration || 0,
      tokensIn: normalizedTokens.in,
      tokensOut: normalizedTokens.out,
      sourceFormat: entry.sourceFormat || null,
      targetFormat: entry.targetFormat || null,
      apiKeyId,
      apiKeyName: entry.apiKeyName || null,
      comboName: entry.comboName || null,
      requestBody: truncatePayload(protectedRequestBody),
      responseBody: truncatePayload(protectedResponseBody),
      error: typeof entry.error === "string" ? sanitizePII(entry.error).text : entry.error || null,
    };

    // 1. Insert into SQLite
    const db = getDbInstance();
    db.prepare(
      `
      INSERT INTO call_logs (id, timestamp, method, path, status, model, provider,
        account, connection_id, duration, tokens_in, tokens_out, source_format, target_format,
        api_key_id, api_key_name, combo_name, request_body, response_body, error)
      VALUES (@id, @timestamp, @method, @path, @status, @model, @provider,
        @account, @connectionId, @duration, @tokensIn, @tokensOut, @sourceFormat, @targetFormat,
        @apiKeyId, @apiKeyName, @comboName, @requestBody, @responseBody, @error)
    `
    ).run(logEntry);

    // 2. Trim old entries beyond CALL_LOGS_MAX
    const countRow = asRecord(db.prepare("SELECT COUNT(*) as cnt FROM call_logs").get());
    const count = toNumber(countRow.cnt);
    if (count > CALL_LOGS_MAX) {
      db.prepare(
        `
        DELETE FROM call_logs WHERE id IN (
          SELECT id FROM call_logs ORDER BY timestamp ASC LIMIT ?
        )
      `
      ).run(count - CALL_LOGS_MAX);
    }

    // 3. Write full payload to disk file (untruncated)
    // Disabled when no-log is active or payload mode is metadata/none.
    if (
      shouldLogPayloadOnDisk &&
      !noLogEnabled &&
      (protectedRequestBody !== null || protectedResponseBody !== null)
    ) {
      writeCallLogToDisk(
        { ...logEntry, tokens: { in: logEntry.tokensIn, out: logEntry.tokensOut } },
        protectedRequestBody,
        protectedResponseBody
      );
    }
  } catch (error: any) {
    console.error("[callLogs] Failed to save call log:", error.message);
  }
}

/**
 * Write call log as JSON file to disk (full payloads, not truncated).
 */
function writeCallLogToDisk(logEntry: any, requestBody: any, responseBody: any) {
  if (!CALL_LOGS_DIR) return;

  try {
    const now = new Date();
    const dateFolder = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const dir = path.join(CALL_LOGS_DIR, dateFolder);

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const safeModel = (logEntry.model || "unknown").replace(/[/:]/g, "-");
    const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const filename = `${time}_${safeModel}_${logEntry.status}.json`;

    const fullEntry = {
      ...logEntry,
      requestBody: requestBody || null,
      responseBody: responseBody || null,
    };

    fs.writeFileSync(path.join(dir, filename), JSON.stringify(fullEntry, null, 2));
  } catch (err: any) {
    console.error("[callLogs] Failed to write disk log:", err.message);
  }
}

/**
 * Rotate old call log directories (keep last 7 days).
 */
export function rotateCallLogs() {
  if (!CALL_LOGS_DIR || !fs.existsSync(CALL_LOGS_DIR)) return;

  try {
    const entries = fs.readdirSync(CALL_LOGS_DIR);
    const now = Date.now();
    const retentionMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      const entryPath = path.join(CALL_LOGS_DIR, entry);
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory() && now - stat.mtimeMs > retentionMs) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        console.log(`[callLogs] Rotated old logs: ${entry}`);
      }
    }
  } catch (err: any) {
    console.error("[callLogs] Failed to rotate logs:", err.message);
  }
}

function backfillCallLogTokenColumns() {
  const db = getDbInstance();
  const rows = db
    .prepare(
      `
      SELECT id, provider, model, connection_id, api_key_id, status, timestamp,
             tokens_in, tokens_out, request_body, response_body
      FROM call_logs
      WHERE status >= 200
        AND status < 300
        AND (COALESCE(tokens_in, 0) = 0 OR COALESCE(tokens_out, 0) = 0)
      `
    )
    .all() as unknown[];

  if (rows.length === 0) return;

  const updateStmt = db.prepare("UPDATE call_logs SET tokens_in = ?, tokens_out = ? WHERE id = ?");
  const modelRatioRows = db
    .prepare(
      `
      SELECT provider, model, SUM(tokens_in) AS in_sum, SUM(tokens_out) AS out_sum
      FROM call_logs
      WHERE status >= 200
        AND status < 300
        AND COALESCE(tokens_in, 0) > 0
        AND COALESCE(tokens_out, 0) > 0
      GROUP BY provider, model
      `
    )
    .all() as unknown[];
  const modelAvgRows = db
    .prepare(
      `
      SELECT provider, model, AVG(tokens_in) AS avg_in, AVG(tokens_out) AS avg_out
      FROM call_logs
      WHERE status >= 200
        AND status < 300
        AND COALESCE(tokens_in, 0) > 0
        AND COALESCE(tokens_out, 0) > 0
      GROUP BY provider, model
      `
    )
    .all() as unknown[];
  const providerRatioRows = db
    .prepare(
      `
      SELECT provider, SUM(tokens_in) AS in_sum, SUM(tokens_out) AS out_sum
      FROM call_logs
      WHERE status >= 200
        AND status < 300
        AND COALESCE(tokens_in, 0) > 0
        AND COALESCE(tokens_out, 0) > 0
      GROUP BY provider
      `
    )
    .all() as unknown[];
  const providerAvgRows = db
    .prepare(
      `
      SELECT provider, AVG(tokens_in) AS avg_in, AVG(tokens_out) AS avg_out
      FROM call_logs
      WHERE status >= 200
        AND status < 300
        AND COALESCE(tokens_in, 0) > 0
        AND COALESCE(tokens_out, 0) > 0
      GROUP BY provider
      `
    )
    .all() as unknown[];
  const globalAverages = asRecord(
    db
      .prepare(
        `
      SELECT AVG(tokens_in) AS avg_in, AVG(tokens_out) AS avg_out
      FROM call_logs
      WHERE status >= 200
        AND status < 300
        AND COALESCE(tokens_in, 0) > 0
        AND COALESCE(tokens_out, 0) > 0
      `
      )
      .get()
  );

  const modelRatioMap = new Map<string, number>();
  const providerRatioMap = new Map<string, number>();
  const modelAvgMap = new Map<string, { in: number; out: number }>();
  const providerAvgMap = new Map<string, { in: number; out: number }>();
  const globalAvg = {
    in: Math.max(0, Math.round(toNumber(globalAverages.avg_in))),
    out: Math.max(0, Math.round(toNumber(globalAverages.avg_out))),
  };
  for (const rowRaw of modelRatioRows) {
    const row = asRecord(rowRaw);
    const provider = toStringOrNull(row.provider);
    const model = toStringOrNull(row.model);
    if (!provider || !model) continue;
    const inSum = toNumber(row.in_sum);
    const outSum = toNumber(row.out_sum);
    if (inSum <= 0 || outSum <= 0) continue;
    modelRatioMap.set(`${provider}::${model}`, outSum / inSum);
  }
  for (const rowRaw of providerRatioRows) {
    const row = asRecord(rowRaw);
    const provider = toStringOrNull(row.provider);
    if (!provider) continue;
    const inSum = toNumber(row.in_sum);
    const outSum = toNumber(row.out_sum);
    if (inSum <= 0 || outSum <= 0) continue;
    providerRatioMap.set(provider, outSum / inSum);
  }
  for (const rowRaw of modelAvgRows) {
    const row = asRecord(rowRaw);
    const provider = toStringOrNull(row.provider);
    const model = toStringOrNull(row.model);
    if (!provider || !model) continue;
    const avgIn = Math.max(0, Math.round(toNumber(row.avg_in)));
    const avgOut = Math.max(0, Math.round(toNumber(row.avg_out)));
    if (avgIn <= 0 || avgOut <= 0) continue;
    modelAvgMap.set(`${provider}::${model}`, { in: avgIn, out: avgOut });
  }
  for (const rowRaw of providerAvgRows) {
    const row = asRecord(rowRaw);
    const provider = toStringOrNull(row.provider);
    if (!provider) continue;
    const avgIn = Math.max(0, Math.round(toNumber(row.avg_in)));
    const avgOut = Math.max(0, Math.round(toNumber(row.avg_out)));
    if (avgIn <= 0 || avgOut <= 0) continue;
    providerAvgMap.set(provider, { in: avgIn, out: avgOut });
  }

  const usageLookupStrict = db.prepare(
    `
      SELECT rowid, tokens_input, tokens_output
      FROM usage_history
      WHERE provider = @provider
        AND model = @model
        AND ((connection_id IS NULL AND @connectionId IS NULL) OR connection_id = @connectionId)
        AND ((api_key_id IS NULL AND @apiKeyId IS NULL) OR api_key_id = @apiKeyId)
        AND timestamp BETWEEN @startTs AND @endTs
      ORDER BY ABS(strftime('%s', timestamp) - strftime('%s', @targetTs)) ASC
      LIMIT 10
    `
  );
  const usageLookupLoose = db.prepare(
    `
      SELECT rowid, tokens_input, tokens_output
      FROM usage_history
      WHERE provider = @provider
        AND model = @model
        AND timestamp BETWEEN @startTs AND @endTs
      ORDER BY ABS(strftime('%s', timestamp) - strftime('%s', @targetTs)) ASC
      LIMIT 10
    `
  );
  const usedUsageRows = new Set<number>();

  const pickUsageCandidate = (
    candidatesRaw: unknown[],
    current: { in: number; out: number }
  ): { rowid: number; in: number; out: number } | null => {
    for (const candidateRaw of candidatesRaw) {
      const candidate = asRecord(candidateRaw);
      const rowid = toNumber(candidate.rowid);
      if (rowid <= 0 || usedUsageRows.has(rowid)) continue;
      const inTokens = toNumber(candidate.tokens_input);
      const outTokens = toNumber(candidate.tokens_output);
      if (current.in <= 0 && inTokens <= 0) continue;
      if (current.out <= 0 && outTokens <= 0) continue;
      return { rowid, in: inTokens, out: outTokens };
    }
    return null;
  };
  const inferMissingWithRatios = (
    current: { in: number; out: number },
    provider: string | null,
    model: string | null
  ): { in: number; out: number } => {
    if (!provider) return current;
    const key = provider && model ? `${provider}::${model}` : null;
    const ratio = (key ? modelRatioMap.get(key) : undefined) ?? providerRatioMap.get(provider);
    if (!ratio || !Number.isFinite(ratio) || ratio <= 0) return current;
    const safeRatio = Math.min(Math.max(ratio, 0.0001), 10);
    const next = { ...current };
    if (next.out <= 0 && next.in > 0) {
      next.out = Math.max(1, Math.round(next.in * safeRatio));
    } else if (next.in <= 0 && next.out > 0) {
      next.in = Math.max(1, Math.round(next.out / safeRatio));
    }
    return next;
  };
  const inferBothZeroWithAverages = (
    current: { in: number; out: number },
    provider: string | null,
    model: string | null
  ): { in: number; out: number } => {
    if (current.in > 0 || current.out > 0) return current;
    const key = provider && model ? `${provider}::${model}` : null;
    const fromModel = key ? modelAvgMap.get(key) : undefined;
    const fromProvider = provider ? providerAvgMap.get(provider) : undefined;
    const selected =
      fromModel || fromProvider || (globalAvg.in > 0 && globalAvg.out > 0 ? globalAvg : null);
    if (!selected) return current;
    return {
      in: Math.max(1, selected.in),
      out: Math.max(1, selected.out),
    };
  };

  let updated = 0;

  for (const rowRaw of rows) {
    const row = asRecord(rowRaw);
    const id = toStringOrNull(row.id);
    if (!id) continue;

    const currentTokens = { in: toNumber(row.tokens_in), out: toNumber(row.tokens_out) };
    let resolved = { ...currentTokens };
    const responseBody = parseJsonString(row.response_body);
    const requestBody = parseJsonString(row.request_body);

    resolved = mergeMissingTokenFields(
      resolved,
      extractTokensFromPayload(responseBody) || extractTokensFromPayload(requestBody)
    );

    const provider = toStringOrNull(row.provider);
    const model = toStringOrNull(row.model);
    const connectionId = toStringOrNull(row.connection_id);
    const apiKeyId = toStringOrNull(row.api_key_id);
    const timestamp = toStringOrNull(row.timestamp);

    if ((resolved.in <= 0 || resolved.out <= 0) && provider && model && timestamp) {
      const startTs = toIsoInWindow(timestamp, -900_000);
      const endTs = toIsoInWindow(timestamp, 900_000);
      if (startTs && endTs) {
        const strictCandidates = usageLookupStrict.all({
          provider,
          model,
          connectionId,
          apiKeyId,
          startTs,
          endTs,
          targetTs: timestamp,
        }) as unknown[];
        let usageMatch = pickUsageCandidate(strictCandidates, resolved);

        if (!usageMatch) {
          const looseCandidates = usageLookupLoose.all({
            provider,
            model,
            startTs,
            endTs,
            targetTs: timestamp,
          }) as unknown[];
          usageMatch = pickUsageCandidate(looseCandidates, resolved);
        }

        if (usageMatch) {
          resolved = mergeMissingTokenFields(resolved, {
            in: usageMatch.in,
            out: usageMatch.out,
          });
          usedUsageRows.add(usageMatch.rowid);
        }
      }
    }

    if (resolved.in <= 0 || resolved.out <= 0) {
      resolved = inferMissingWithRatios(resolved, provider, model);
    }
    if (resolved.in <= 0 && resolved.out <= 0) {
      resolved = inferBothZeroWithAverages(resolved, provider, model);
    }

    resolved = mergeMissingTokenFields(
      resolved,
      estimateTokenPairFromBodies(requestBody, responseBody)
    );

    if (resolved.in === currentTokens.in && resolved.out === currentTokens.out) continue;
    if (resolved.in <= 0 && resolved.out <= 0) continue;

    updateStmt.run(resolved.in, resolved.out, id);
    updated++;
  }

  if (updated > 0) {
    console.log(`[callLogs] Backfilled token columns for ${updated} existing log rows`);
  }
}

// Run rotation on startup
if (shouldPersistToDisk) {
  try {
    rotateCallLogs();
  } catch {}
  try {
    backfillCallLogTokenColumns();
  } catch (err: any) {
    console.error("[callLogs] Failed to backfill token columns:", err.message);
  }
}

/**
 * Get call logs with optional filtering.
 */
export async function getCallLogs(filter: any = {}) {
  const db = getDbInstance();
  let sql = "SELECT * FROM call_logs";
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.status) {
    if (filter.status === "error") {
      conditions.push("(status >= 400 OR error IS NOT NULL)");
    } else if (filter.status === "ok") {
      conditions.push("status >= 200 AND status < 300");
    } else {
      const statusCode = parseInt(filter.status);
      if (!isNaN(statusCode)) {
        conditions.push("status = @statusCode");
        params.statusCode = statusCode;
      }
    }
  }

  if (filter.model) {
    conditions.push("model LIKE @modelQ");
    params.modelQ = `%${filter.model}%`;
  }
  if (filter.provider) {
    conditions.push("provider LIKE @providerQ");
    params.providerQ = `%${filter.provider}%`;
  }
  if (filter.account) {
    conditions.push("account LIKE @accountQ");
    params.accountQ = `%${filter.account}%`;
  }
  if (filter.apiKey) {
    conditions.push("(api_key_name LIKE @apiKeyQ OR api_key_id LIKE @apiKeyQ)");
    params.apiKeyQ = `%${filter.apiKey}%`;
  }
  if (filter.combo) {
    conditions.push("combo_name IS NOT NULL");
  }
  if (filter.search) {
    conditions.push(`(
      model LIKE @searchQ OR path LIKE @searchQ OR account LIKE @searchQ OR
      provider LIKE @searchQ OR api_key_name LIKE @searchQ OR api_key_id LIKE @searchQ OR
      combo_name LIKE @searchQ OR CAST(status AS TEXT) LIKE @searchQ
    )`);
    params.searchQ = `%${filter.search}%`;
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  const limit = filter.limit || 200;
  sql += ` ORDER BY timestamp DESC LIMIT ${limit}`;

  const rows = db.prepare(sql).all(params);

  return rows.map((row) => {
    const l = asRecord(row);
    return {
      id: toStringOrNull(l.id),
      timestamp: toStringOrNull(l.timestamp),
      method: toStringOrNull(l.method),
      path: toStringOrNull(l.path),
      status: toNumber(l.status),
      model: toStringOrNull(l.model),
      provider: toStringOrNull(l.provider),
      account: toStringOrNull(l.account),
      duration: toNumber(l.duration),
      tokens: { in: toNumber(l.tokens_in), out: toNumber(l.tokens_out) },
      sourceFormat: toStringOrNull(l.source_format),
      targetFormat: toStringOrNull(l.target_format),
      error: toStringOrNull(l.error),
      comboName: toStringOrNull(l.combo_name),
      apiKeyId: toStringOrNull(l.api_key_id),
      apiKeyName: toStringOrNull(l.api_key_name),
      hasRequestBody: typeof l.request_body === "string" && l.request_body.length > 0,
      hasResponseBody: typeof l.response_body === "string" && l.response_body.length > 0,
    };
  });
}

/**
 * Get a single call log by ID (with full payloads from disk when available).
 */
export async function getCallLogById(id: string) {
  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM call_logs WHERE id = ?").get(id);
  if (!row) return null;
  const entryRow = asRecord(row);

  const entry = {
    id: toStringOrNull(entryRow.id),
    timestamp: toStringOrNull(entryRow.timestamp),
    method: toStringOrNull(entryRow.method),
    path: toStringOrNull(entryRow.path),
    status: toNumber(entryRow.status),
    model: toStringOrNull(entryRow.model),
    provider: toStringOrNull(entryRow.provider),
    account: toStringOrNull(entryRow.account),
    connectionId: toStringOrNull(entryRow.connection_id),
    duration: toNumber(entryRow.duration),
    tokens: { in: toNumber(entryRow.tokens_in), out: toNumber(entryRow.tokens_out) },
    sourceFormat: toStringOrNull(entryRow.source_format),
    targetFormat: toStringOrNull(entryRow.target_format),
    apiKeyId: toStringOrNull(entryRow.api_key_id),
    apiKeyName: toStringOrNull(entryRow.api_key_name),
    comboName: toStringOrNull(entryRow.combo_name),
    requestBody: parseJsonString(entryRow.request_body),
    responseBody: parseJsonString(entryRow.response_body),
    error: toStringOrNull(entryRow.error),
  };

  // If payloads were truncated, try to read full version from disk
  const needsDisk = hasTruncatedFlag(entry.requestBody) || hasTruncatedFlag(entry.responseBody);
  if (needsDisk && CALL_LOGS_DIR) {
    try {
      const diskEntry = readFullLogFromDisk(entry);
      if (diskEntry) {
        return {
          ...entry,
          requestBody: diskEntry.requestBody ?? entry.requestBody,
          responseBody: diskEntry.responseBody ?? entry.responseBody,
        };
      }
    } catch (err: any) {
      console.error("[callLogs] Failed to read full log from disk:", err.message);
    }
  }

  return entry;
}

/**
 * Read the full (untruncated) log entry from disk.
 */
function readFullLogFromDisk(entry: any) {
  if (!CALL_LOGS_DIR || !entry.timestamp) return null;

  try {
    const date = new Date(entry.timestamp);
    const dateFolder = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const dir = path.join(CALL_LOGS_DIR, dateFolder);

    if (!fs.existsSync(dir)) return null;

    const time = `${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
    const safeModel = (entry.model || "unknown").replace(/[/:]/g, "-");
    const expectedName = `${time}_${safeModel}_${entry.status}.json`;

    const exactPath = path.join(dir, expectedName);
    if (fs.existsSync(exactPath)) {
      return JSON.parse(fs.readFileSync(exactPath, "utf8"));
    }

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(time) && f.endsWith(`_${entry.status}.json`));
    if (files.length > 0) {
      return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
    }
  } catch (err: any) {
    console.error("[callLogs] Disk log read error:", err.message);
  }

  return null;
}
