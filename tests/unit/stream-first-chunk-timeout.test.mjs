import test from "node:test";
import assert from "node:assert/strict";
import { ensureFirstStreamChunk } from "../../open-sse/handlers/chatCore.ts";

test("ensureFirstStreamChunk passes through started streams", async () => {
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: hello\n\n"));
      controller.close();
    },
  });
  const response = new Response(source, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  const wrapped = await ensureFirstStreamChunk(response, 100, "kiro", "claude-sonnet-4.5", null);
  assert.equal(wrapped.status, 200);
  const body = await wrapped.text();
  assert.match(body, /data: hello/);
});

test("ensureFirstStreamChunk throws when no chunk arrives before timeout", async () => {
  const source = new ReadableStream({
    start() {
      // Intentionally never enqueue any chunk.
    },
  });
  const response = new Response(source, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  await assert.rejects(
    () => ensureFirstStreamChunk(response, 30, "kiro", "claude-sonnet-4.5", null),
    /No stream data received/
  );
});
