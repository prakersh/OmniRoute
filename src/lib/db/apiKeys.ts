/**
 * db/apiKeys.js — API key management.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbInstance, rowToCamel } from "./core";
import { backupDbFile } from "./backup";
import { registerDbStateResetter } from "./stateReset";
import { setNoLog } from "../compliance";

// ──────────────── Performance Optimizations ────────────────

// Schema check memoization - only run once
let _schemaChecked = false;

type JsonRecord = Record<string, unknown>;

interface CacheEntry<TValue> {
  timestamp: number;
  value: TValue;
}

interface ApiKeyMetadata {
  id: string;
  name: string;
  machineId: string | null;
  allowedModels: string[];
  noLog: boolean;
}

interface ApiKeyRow extends JsonRecord {
  id?: unknown;
  name?: unknown;
  key?: unknown;
  machine_id?: unknown;
  machineId?: unknown;
  allowed_models?: unknown;
  allowedModels?: unknown;
  no_log?: unknown;
  noLog?: unknown;
}

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface ApiKeysDbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
  exec: (sql: string) => void;
}

interface ApiKeysStatements {
  getAllKeys: StatementLike<ApiKeyRow>;
  getKeyById: StatementLike<ApiKeyRow>;
  validateKey: StatementLike<JsonRecord>;
  getKeyMetadata: StatementLike<ApiKeyRow>;
  insertKey: StatementLike;
  deleteKey: StatementLike;
}

interface ApiKeyView extends JsonRecord {
  id?: string;
  allowedModels: string[];
  noLog: boolean;
}

// LRU cache for API key validation (valid keys only)
const _keyValidationCache = new Map<string, { valid: boolean; timestamp: number }>();
const _keyMetadataCache = new Map<string, CacheEntry<ApiKeyMetadata>>();
const CACHE_TTL = 60 * 1000; // 1 minute TTL
const MAX_CACHE_SIZE = 1000;

// Compiled regex cache for wildcard patterns
const _regexCache = new Map<string, RegExp>();

// Cache for model permission checks
const _modelPermissionCache = new Map<string, { allowed: boolean; timestamp: number }>();

// Prepared statements cache
let _stmtGetAllKeys: ApiKeysStatements["getAllKeys"] | null = null;
let _stmtGetKeyById: ApiKeysStatements["getKeyById"] | null = null;
let _stmtValidateKey: ApiKeysStatements["validateKey"] | null = null;
let _stmtGetKeyMetadata: ApiKeysStatements["getKeyMetadata"] | null = null;
let _stmtInsertKey: ApiKeysStatements["insertKey"] | null = null;
let _stmtDeleteKey: ApiKeysStatements["deleteKey"] | null = null;

/**
 * Clear all caches (called on key create/update/delete)
 */
function invalidateCaches() {
  _keyValidationCache.clear();
  _keyMetadataCache.clear();
  _modelPermissionCache.clear();
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

/**
 * LRU eviction for cache
 */
function evictIfNeeded<TKey, TValue>(cache: Map<TKey, TValue>) {
  if (cache.size > MAX_CACHE_SIZE) {
    // Remove oldest 20% of entries
    const entriesToRemove = Math.floor(MAX_CACHE_SIZE * 0.2);
    let i = 0;
    for (const key of cache.keys()) {
      if (i++ >= entriesToRemove) break;
      cache.delete(key);
    }
  }
}

/**
 * Get or compile regex for wildcard pattern
 */
function getWildcardRegex(pattern: string): RegExp {
  let regex = _regexCache.get(pattern);
  if (!regex) {
    const regexStr = pattern.replace(/\*/g, ".*");
    regex = new RegExp(`^${regexStr}$`);
    _regexCache.set(pattern, regex);
    // Prevent unbounded growth
    if (_regexCache.size > 100) {
      const firstKey = _regexCache.keys().next().value;
      if (firstKey) _regexCache.delete(firstKey);
    }
  }
  return regex;
}

// Ensure api_keys extension columns exist (memoized)
function ensureApiKeysColumns(db: ApiKeysDbLike) {
  if (_schemaChecked) return;

  try {
    const columns = db.prepare<ApiKeyRow>("PRAGMA table_info(api_keys)").all();
    const columnNames = new Set(columns.map((column) => String(column.name ?? "")));
    if (!columnNames.has("allowed_models")) {
      db.exec("ALTER TABLE api_keys ADD COLUMN allowed_models TEXT");
      console.log("[DB] Added api_keys.allowed_models column");
    }
    if (!columnNames.has("no_log")) {
      db.exec("ALTER TABLE api_keys ADD COLUMN no_log INTEGER NOT NULL DEFAULT 0");
      console.log("[DB] Added api_keys.no_log column");
    }
    _schemaChecked = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[DB] Failed to verify api_keys schema:", message);
  }
}

/**
 * Initialize prepared statements (lazy initialization)
 */
function getPreparedStatements(db: ApiKeysDbLike): ApiKeysStatements {
  ensureApiKeysColumns(db);

  if (
    !_stmtGetAllKeys ||
    !_stmtGetKeyById ||
    !_stmtValidateKey ||
    !_stmtGetKeyMetadata ||
    !_stmtInsertKey ||
    !_stmtDeleteKey
  ) {
    _stmtGetAllKeys = db.prepare<ApiKeyRow>("SELECT * FROM api_keys ORDER BY created_at");
    _stmtGetKeyById = db.prepare<ApiKeyRow>("SELECT * FROM api_keys WHERE id = ?");
    _stmtValidateKey = db.prepare<JsonRecord>("SELECT 1 FROM api_keys WHERE key = ?");
    _stmtGetKeyMetadata = db.prepare<ApiKeyRow>(
      "SELECT id, name, machine_id, allowed_models, no_log FROM api_keys WHERE key = ?"
    );
    _stmtInsertKey = db.prepare(
      "INSERT INTO api_keys (id, name, key, machine_id, allowed_models, no_log, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    _stmtDeleteKey = db.prepare("DELETE FROM api_keys WHERE id = ?");
  }

  if (
    !_stmtGetAllKeys ||
    !_stmtGetKeyById ||
    !_stmtValidateKey ||
    !_stmtGetKeyMetadata ||
    !_stmtInsertKey ||
    !_stmtDeleteKey
  ) {
    throw new Error("Failed to initialize API key prepared statements");
  }

  return {
    getAllKeys: _stmtGetAllKeys,
    getKeyById: _stmtGetKeyById,
    validateKey: _stmtValidateKey,
    getKeyMetadata: _stmtGetKeyMetadata,
    insertKey: _stmtInsertKey,
    deleteKey: _stmtDeleteKey,
  };
}

export async function getApiKeys() {
  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const rows = stmt.getAllKeys.all();
  return rows.map((row) => {
    const camelRow = toRecord(rowToCamel(row)) as ApiKeyView;
    camelRow.allowedModels = parseAllowedModels(camelRow.allowedModels);
    camelRow.noLog = parseNoLog(camelRow.noLog);
    if (typeof camelRow.id === "string" && camelRow.id.length > 0) {
      setNoLog(camelRow.id, camelRow.noLog === true);
    }
    return camelRow;
  });
}

export async function getApiKeyById(id: string) {
  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const row = stmt.getKeyById.get(id);
  if (!row) return null;
  const camelRow = toRecord(rowToCamel(row)) as ApiKeyView;
  camelRow.allowedModels = parseAllowedModels(camelRow.allowedModels);
  camelRow.noLog = parseNoLog(camelRow.noLog);
  if (typeof camelRow.id === "string" && camelRow.id.length > 0) {
    setNoLog(camelRow.id, camelRow.noLog === true);
  }
  return camelRow;
}

/**
 * Helper function to safely parse allowed_models JSON
 */
function parseAllowedModels(value: unknown): string[] {
  if (!value || typeof value !== "string" || value.trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseNoLog(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export async function createApiKey(name: string, machineId: string) {
  if (!machineId) {
    throw new Error("machineId is required");
  }

  const db = getDbInstance() as ApiKeysDbLike;
  const now = new Date().toISOString();

  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);

  const apiKey = {
    id: uuidv4(),
    name: name,
    key: result.key,
    machineId: machineId,
    allowedModels: [], // Empty array means all models allowed
    noLog: false,
    createdAt: now,
  };

  const stmt = getPreparedStatements(db);
  stmt.insertKey.run(
    apiKey.id,
    apiKey.name,
    apiKey.key,
    apiKey.machineId,
    "[]",
    0,
    apiKey.createdAt
  );
  setNoLog(apiKey.id, false);

  backupDbFile("pre-write");
  return apiKey;
}

export async function updateApiKeyPermissions(
  id: string,
  update: string[] | { allowedModels?: string[]; noLog?: boolean }
) {
  const db = getDbInstance() as ApiKeysDbLike;
  getPreparedStatements(db);

  const normalized =
    Array.isArray(update) || update === undefined
      ? { allowedModels: update || [] }
      : {
          allowedModels: update.allowedModels,
          noLog: update.noLog,
        };

  if (normalized.allowedModels === undefined && normalized.noLog === undefined) {
    return false;
  }

  const updates: string[] = [];
  const params: { id: string; allowedModels?: string; noLog?: number } = { id };

  if (normalized.allowedModels !== undefined) {
    // Empty array means all models are allowed
    updates.push("allowed_models = @allowedModels");
    params.allowedModels = JSON.stringify(normalized.allowedModels || []);
  }

  if (normalized.noLog !== undefined) {
    updates.push("no_log = @noLog");
    params.noLog = normalized.noLog ? 1 : 0;
  }

  const result = db.prepare(`UPDATE api_keys SET ${updates.join(", ")} WHERE id = @id`).run(params);

  if (result.changes === 0) return false;

  if (normalized.noLog !== undefined) {
    setNoLog(id, normalized.noLog);
  }

  // Invalidate caches since permissions changed
  invalidateCaches();

  backupDbFile("pre-write");
  return true;
}

export async function deleteApiKey(id: string) {
  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const result = stmt.deleteKey.run(id);

  if (result.changes === 0) return false;

  setNoLog(id, false);

  // Invalidate caches since a key was removed
  invalidateCaches();

  backupDbFile("pre-write");
  return true;
}

/**
 * Validate API key with caching for performance
 * Cached valid keys reduce DB hits on every request
 */
export async function validateApiKey(key: string | null | undefined) {
  if (!key || typeof key !== "string") return false;

  const now = Date.now();

  // Check cache first
  const cached = _keyValidationCache.get(key);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.valid;
  }

  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const row = stmt.validateKey.get(key);
  const valid = !!row;

  // Only cache valid keys to prevent cache pollution
  if (valid) {
    evictIfNeeded(_keyValidationCache);
    _keyValidationCache.set(key, { valid: true, timestamp: now });
  }

  return valid;
}

/**
 * Get API key metadata with caching for performance
 */
export async function getApiKeyMetadata(
  key: string | null | undefined
): Promise<ApiKeyMetadata | null> {
  if (!key || typeof key !== "string") return null;

  const now = Date.now();

  // Check cache first
  const cached = _keyMetadataCache.get(key);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.value;
  }

  const db = getDbInstance() as ApiKeysDbLike;
  const stmt = getPreparedStatements(db);
  const row = stmt.getKeyMetadata.get(key);

  if (!row) return null;

  const record = toRecord(row) as ApiKeyRow;
  const metadataId = typeof record.id === "string" ? record.id : "";
  const metadataName = typeof record.name === "string" ? record.name : "";
  const machineIdRaw = record.machine_id ?? record.machineId;
  const metadataMachineId = typeof machineIdRaw === "string" ? machineIdRaw : null;

  const metadata: ApiKeyMetadata = {
    id: metadataId,
    name: metadataName,
    machineId: metadataMachineId,
    allowedModels: parseAllowedModels(record.allowed_models ?? record.allowedModels),
    noLog: parseNoLog(record.no_log ?? record.noLog),
  };

  if (!metadata.id) {
    return null;
  }

  setNoLog(metadata.id, metadata.noLog === true);

  // Cache the result
  evictIfNeeded(_keyMetadataCache);
  _keyMetadataCache.set(key, { value: metadata, timestamp: now });

  return metadata;
}

/**
 * Check if a model is allowed for a given API key
 * @param {string} key - The API key
 * @param {string} modelId - The model ID to check
 * @returns {boolean} - true if allowed, false if not
 */
export async function isModelAllowedForKey(
  key: string | null | undefined,
  modelId: string | null | undefined
) {
  // If no key provided, allow (request may be using different auth method like JWT)
  // If no modelId provided, deny (invalid request)
  if (!key) return true;
  if (!modelId) return false;

  // Create cache key
  const cacheKey = `${key}:${modelId}`;
  const now = Date.now();

  // Check permission cache
  const cached = _modelPermissionCache.get(cacheKey);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.allowed;
  }

  const metadata = await getApiKeyMetadata(key);
  // SECURITY: Key not found in database = deny access (invalid/non-existent key)
  if (!metadata) return false;

  const { allowedModels } = metadata;

  // Empty array means all models allowed
  if (!allowedModels || allowedModels.length === 0) {
    return true;
  }

  let allowed = false;

  // Check if model matches each allowed pattern
  // Support exact match and prefix match (e.g., "openai/*" allows all OpenAI models)
  for (const pattern of allowedModels) {
    if (pattern === modelId) {
      allowed = true;
      break;
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2); // Remove "/*"
      if (modelId.startsWith(prefix + "/") || modelId.startsWith(prefix)) {
        allowed = true;
        break;
      }
    }
    // Support wildcard patterns using cached regex
    if (pattern.includes("*")) {
      const regex = getWildcardRegex(pattern);
      if (regex.test(modelId)) {
        allowed = true;
        break;
      }
    }
  }

  // Cache the result
  evictIfNeeded(_modelPermissionCache);
  _modelPermissionCache.set(cacheKey, { allowed, timestamp: now });

  return allowed;
}

/**
 * Clear prepared statements cache (called on database reset/restore)
 * Prepared statements are bound to a specific database connection,
 * so they must be cleared when the connection is reset.
 */
function clearPreparedStatementCache() {
  _stmtGetAllKeys = null;
  _stmtGetKeyById = null;
  _stmtValidateKey = null;
  _stmtGetKeyMetadata = null;
  _stmtInsertKey = null;
  _stmtDeleteKey = null;
  _schemaChecked = false; // Also reset schema check for new connection
}

/**
 * Clear all caches (exported for testing/debugging)
 */
export function clearApiKeyCaches() {
  invalidateCaches();
  _modelPermissionCache.clear();
  _regexCache.clear();
}

/**
 * Reset all cached state for database connection reset/restore.
 * Called by backup.ts when the database is restored.
 */
export function resetApiKeyState() {
  clearPreparedStatementCache();
  clearApiKeyCaches();
}

registerDbStateResetter(resetApiKeyState);
