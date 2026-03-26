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

/**
 * Check if a tool definition is valid for strict anthropic-compatible providers.
 * MiniMax rejects tools where "function name or parameters is empty".
 */
function isValidTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") return false;
  const record = tool as JsonRecord;

  // Must have a non-empty name
  const name = getToolName(tool);
  if (!name || name.trim().length === 0) return false;

  // Must have input_schema with at least a type field (Claude format)
  const schema = record.input_schema;
  if (schema && typeof schema === "object") {
    const schemaRecord = schema as JsonRecord;
    // Empty schema {} is OK — MiniMax accepts {type:"object"} or even {}
    // But undefined/null schema on a tool is not OK
    return true;
  }

  // OpenAI format: check function.parameters
  const fn = record.function;
  if (fn && typeof fn === "object") {
    return true; // has function block, parameters optional in OpenAI
  }

  // No schema at all — strip it
  return false;
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

  // Filter invalid tool definitions (empty name, missing schema, etc.)
  // MiniMax rejects with 400 "function name or parameters is empty"
  if (Array.isArray(normalized.tools)) {
    const validTools = normalized.tools.filter((tool) => isValidTool(tool));

    if (validTools.length === 0) {
      delete normalized.tools;
      // Also remove tool_choice if tools are gone
      delete normalized.tool_choice;
      strippedFields.push("tools");
    } else if (validTools.length !== normalized.tools.length) {
      normalized.tools = validTools;
      strippedFields.push("tools(invalid)");
    }
  }

  // Strip empty tool_use blocks from messages (compaction artifacts)
  // Claude Code compaction can leave tool_use with empty names or tool_result orphans
  if (Array.isArray(normalized.messages)) {
    let messagesModified = false;
    normalized.messages = (normalized.messages as JsonRecord[]).map((msg) => {
      if (!Array.isArray(msg.content)) return msg;

      const filtered = (msg.content as JsonRecord[]).filter((block) => {
        // Strip tool_use with empty name
        if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name.trim() : "";
          if (!name) {
            messagesModified = true;
            return false;
          }
        }
        return true;
      });

      if (filtered.length === (msg.content as JsonRecord[]).length) return msg;
      // If all content was stripped, keep at least an empty text block
      if (filtered.length === 0) {
        messagesModified = true;
        return { ...msg, content: [{ type: "text", text: "" }] };
      }
      return { ...msg, content: filtered };
    });

    // Remove orphaned tool_result messages (tool_result without matching tool_use)
    const toolUseIds = new Set<string>();
    for (const msg of normalized.messages as JsonRecord[]) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content as JsonRecord[]) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          toolUseIds.add(block.id);
        }
      }
    }

    normalized.messages = (normalized.messages as JsonRecord[]).map((msg) => {
      if (!Array.isArray(msg.content)) return msg;

      const filtered = (msg.content as JsonRecord[]).filter((block) => {
        if (block.type === "tool_result") {
          const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          if (!toolUseId || !toolUseIds.has(toolUseId)) {
            messagesModified = true;
            return false;
          }
        }
        return true;
      });

      if (filtered.length === (msg.content as JsonRecord[]).length) return msg;
      if (filtered.length === 0) {
        return { ...msg, content: [{ type: "text", text: "" }] };
      }
      return { ...msg, content: filtered };
    });

    // Remove messages with only empty text blocks (cleanup artifacts)
    const beforeLen = (normalized.messages as JsonRecord[]).length;
    normalized.messages = (normalized.messages as JsonRecord[]).filter((msg) => {
      if (!Array.isArray(msg.content)) return true;
      const content = msg.content as JsonRecord[];
      if (content.length === 1 && content[0].type === "text" && content[0].text === "") {
        return false;
      }
      return true;
    });

    if (messagesModified || (normalized.messages as JsonRecord[]).length !== beforeLen) {
      strippedFields.push("messages(sanitized)");
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
