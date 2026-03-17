type JsonRecord = Record<string, unknown>;

const NATIVE_CLAUDE_PROVIDERS = new Set(["claude", "anthropic"]);

function flattenClaudeSystemBlocks(system: unknown): string | null {
  if (!Array.isArray(system)) return null;

  const parts: string[] = [];
  for (const block of system) {
    if (typeof block === "string") {
      const text = block.trim();
      if (text) parts.push(text);
      continue;
    }

    if (block && typeof block === "object") {
      const record = block as JsonRecord;
      const type = typeof record.type === "string" ? record.type : "text";
      if (type === "text" && typeof record.text === "string") {
        const text = record.text.trim();
        if (text) parts.push(text);
        continue;
      }
    }

    // Keep original structure when non-text blocks are present.
    return null;
  }

  return parts.join("\n\n");
}

function getToolName(tool: unknown): string | null {
  if (!tool || typeof tool !== "object") return null;

  const record = tool as JsonRecord;
  if (typeof record.name === "string") {
    return record.name;
  }

  const fn = record.function;
  if (fn && typeof fn === "object") {
    const fnRecord = fn as JsonRecord;
    if (typeof fnRecord.name === "string") {
      return fnRecord.name;
    }
  }

  return null;
}

export function isNativeClaudeProvider(provider?: string | null): boolean {
  if (typeof provider !== "string") return false;
  return NATIVE_CLAUDE_PROVIDERS.has(provider.toLowerCase());
}

export function normalizeClaudePassthroughForProvider(
  body: JsonRecord,
  provider?: string | null
): { body: JsonRecord; strippedFields: string[] } {
  const normalized: JsonRecord = { ...body };
  const strippedFields: string[] = [];

  if (isNativeClaudeProvider(provider)) {
    return { body: normalized, strippedFields };
  }

  // MiniMax/Boss and anthropic-compatible backends reject Claude Code output_config.
  if ("output_config" in normalized) {
    delete normalized.output_config;
    strippedFields.push("output_config");
  }

  // Empty tools arrays can trigger strict validators on some compatible backends.
  if (Array.isArray(normalized.tools)) {
    const validTools = normalized.tools.filter((tool) => {
      const name = getToolName(tool);
      return name === null || name.trim().length > 0;
    });

    if (validTools.length === 0) {
      delete normalized.tools;
      strippedFields.push("tools");
    } else if (validTools.length !== normalized.tools.length) {
      normalized.tools = validTools;
      strippedFields.push("tools(empty-name)");
    }
  }

  // Flatten text-only system blocks to a plain string for stricter compat providers.
  const flattenedSystem = flattenClaudeSystemBlocks(normalized.system);
  if (flattenedSystem !== null) {
    if (flattenedSystem.length > 0) {
      normalized.system = flattenedSystem;
      strippedFields.push("system(blocks)");
    } else {
      delete normalized.system;
      strippedFields.push("system");
    }
  }

  return { body: normalized, strippedFields };
}
