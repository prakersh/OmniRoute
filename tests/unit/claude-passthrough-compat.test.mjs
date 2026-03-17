import test from "node:test";
import assert from "node:assert/strict";

import {
  isNativeClaudeProvider,
  normalizeClaudePassthroughForProvider,
} from "../../open-sse/services/claudePassthrough.ts";

test("isNativeClaudeProvider matches only native Claude backends", () => {
  assert.equal(isNativeClaudeProvider("claude"), true);
  assert.equal(isNativeClaudeProvider("anthropic"), true);
  assert.equal(isNativeClaudeProvider("minimax"), false);
  assert.equal(isNativeClaudeProvider("anthropic-compatible-prod"), false);
});

test("normalizeClaudePassthroughForProvider strips unsupported fields for non-native providers", () => {
  const input = {
    model: "MiniMax-M2.5",
    max_tokens: 32000,
    stream: true,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: 'Return JSON with only {"name":"..."}' },
    ],
    tools: [],
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: { type: "object" } },
    },
    metadata: { user_id: "u_123" },
  };

  const { body, strippedFields } = normalizeClaudePassthroughForProvider(input, "minimax");

  assert.ok("output_config" in input, "input object should not be mutated");
  assert.equal(body.output_config, undefined);
  assert.equal(body.tools, undefined);
  assert.equal(
    body.system,
    'You are Claude Code, Anthropic\'s official CLI for Claude.\n\nReturn JSON with only {"name":"..."}'
  );
  assert.deepEqual(body.metadata, { user_id: "u_123" });
  assert.equal(body.max_tokens, 32000);
  assert.deepEqual(strippedFields.sort(), ["output_config", "system(blocks)", "tools"].sort());
});

test("normalizeClaudePassthroughForProvider removes only invalid tool definitions", () => {
  const input = {
    tools: [
      { name: "", input_schema: {} },
      { name: "ok_tool", input_schema: {} },
      { function: { name: "", parameters: {} } },
      { function: { name: "ok_fn", parameters: {} } },
    ],
  };

  const { body, strippedFields } = normalizeClaudePassthroughForProvider(
    input,
    "anthropic-compatible-team"
  );

  assert.equal(Array.isArray(body.tools), true);
  assert.equal(body.tools.length, 2);
  assert.deepEqual(
    body.tools.map((tool) => tool.name ?? tool.function?.name),
    ["ok_tool", "ok_fn"]
  );
  assert.equal(strippedFields.includes("tools(empty-name)"), true);
});

test("normalizeClaudePassthroughForProvider keeps native Claude payload untouched", () => {
  const input = {
    output_config: { effort: "medium" },
    tools: [],
    system: [{ type: "text", text: "native" }],
  };

  const { body, strippedFields } = normalizeClaudePassthroughForProvider(input, "claude");

  assert.deepEqual(body, input);
  assert.notEqual(body, input);
  assert.deepEqual(strippedFields, []);
});
