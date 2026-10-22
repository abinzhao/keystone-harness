import assert from "node:assert/strict";
import test from "node:test";
import { JsonlDecoder, ExecEvents, decodeModels } from "../src/codec.ts";

test("UTF-8 frames survive every byte boundary, blanks and CRLF", () => {
  const bytes = Buffer.from('\n{"type":"x","text":"中文"}\r\n{"type":"y"}\n');
  for (let width = 1; width <= bytes.length; width++) {
    const decoder = new JsonlDecoder(1000, 100);
    const frames: unknown[] = [];
    for (let offset = 0; offset < bytes.length; offset += width) {
      frames.push(...decoder.push(bytes.subarray(offset, offset + width)));
    }
    decoder.finish();
    assert.deepEqual(frames, [{ type: "x", text: "中文" }, { type: "y" }]);
  }
});

test("invalid UTF-8, truncated frame, nonobject JSON and byte/frame floods fail closed", () => {
  for (const bytes of [Buffer.from([0xc3, 0x28, 10]), Buffer.from("[]\n"), Buffer.from("{oops}\n")]) {
    assert.throws(() => new JsonlDecoder(100, 80).push(bytes), { code: "protocol" });
  }
  const truncated = new JsonlDecoder(100, 80);
  truncated.push(Buffer.from('{"x":1}'));
  assert.throws(() => truncated.finish(), { code: "protocol" });
  assert.throws(() => new JsonlDecoder(10, 5).push(Buffer.from("123456")), { code: "output_limit" });
  assert.throws(() => new JsonlDecoder(4, 4).push(Buffer.from("{}\n{}\n")), { code: "output_limit" });
});

test("only final JSON answer becomes an inert text envelope; usage is measured", () => {
  const events = new ExecEvents();
  events.accept({ type: "thread.started", thread_id: "unreturned-private-id" });
  events.accept({ type: "turn.started" });
  events.accept({ type: "item.completed", item: { type: "reasoning", text: "never return this" } });
  events.accept({ type: "item.completed", item: { type: "agent_message", text: '{"summary":"Done","actions":[]}' } });
  events.accept({ type: "turn.completed", usage: { input_tokens: 13, output_tokens: 7, cached_input_tokens: 3 } });
  assert.deepEqual(events.finish(), {
    text: '{"summary":"Done","actions":[]}',
    usage: { inputTokens: 13, outputTokens: 7 },
    measuredUsage: { inputTokens: 13, outputTokens: 7, cachedInputTokens: 3 },
  });
});

test("public answer survives as bounded untrusted text, not hidden reasoning or authority", () => {
  const events = new ExecEvents();
  const text = '{"summary":"Analysis","answer":"Public result with file:line references","actions":[]}';
  events.accept({ type: "item.completed", item: { type: "agent_message", text } });
  events.accept({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(events.finish().text, text);
  const oversized = new ExecEvents();
  oversized.accept({ type: "item.completed", item: { type: "agent_message",
    text: JSON.stringify({ summary: "Analysis", answer: "x".repeat(65537), actions: [] }) } });
  oversized.accept({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  assert.throws(() => oversized.finish(), { code: "protocol" });
});

test("tools, hooks, approvals, unknown events and late/duplicate final events are refused", () => {
  for (const frame of [
    { type: "item.started", item: { type: "command_execution" } },
    { type: "item.completed", item: { type: "file_change" } },
    { type: "hook.started" },
    { type: "approval.required" },
    { type: "item.completed", item: { type: "mcp_tool_call" } },
  ]) assert.throws(() => new ExecEvents().accept(frame), { code: "isolation_violation" });
  assert.throws(() => new ExecEvents().accept({ type: "new.future.event" }), { code: "protocol" });
  const events = new ExecEvents();
  events.accept({ type: "item.completed", item: { type: "agent_message", text: '{"summary":"x","actions":[]}' } });
  events.accept({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  assert.throws(() => events.accept({ type: "turn.completed" }), { code: "protocol" });
});

test("missing/invalid usage, absent final JSON, and malformed envelopes never fabricate success", () => {
  for (const text of ["not JSON", '{"actions":[]}', '{"summary":"x","actions":null}', '{"summary":"x","actions":[],"proven":true}']) {
    const events = new ExecEvents();
    events.accept({ type: "item.completed", item: { type: "agent_message", text } });
    events.accept({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });
    assert.throws(() => events.finish(), { code: "protocol" });
  }
  for (const usage of [undefined, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 1, output_tokens: 2, cached_input_tokens: 3 }]) {
    const events = new ExecEvents();
    events.accept({ type: "turn.completed", usage });
    assert.throws(() => events.finish());
  }
});

test("known native error codes are classified without echoing provider messages", () => {
  for (const [native, code] of [["unauthorized", "authentication"], ["model_not_found", "model_unavailable"], ["rate_limit_exceeded", "rate_limit"], ["insufficient_quota", "quota"]]) {
    assert.throws(() => new ExecEvents().accept({ type: "error", code: native, message: "SECRET never echo" }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === code && !error.message.includes("SECRET"));
  }
  assert.throws(() => new ExecEvents().accept({ type: "error", message: "SECRET" }), { code: "cli_failed" });
});

test("model discovery projects only safe names, never quota/account/provider metadata", () => {
  assert.deepEqual(decodeModels({ models: [
    { id: "seed-test", display_name: "Seed Test", quota: 99, account: "PRIVATE", endpoint: "PRIVATE" },
    { id: "opus-test", name: "Opus Test" },
  ] }), [{ modelName: "seed-test", displayName: "Seed Test" }, { modelName: "opus-test", displayName: "Opus Test" }]);
  assert.throws(() => decodeModels({ models: [{ id: "--config=secret" }] }), { code: "protocol" });
  assert.throws(() => decodeModels({ models: [{ id: "one" }, { id: "one" }] }), { code: "protocol" });
  assert.throws(() => decodeModels({ models: [{ id: "safe", display_name: "user@example.com" }] }), { code: "protocol" });
});

test("only explicitly suppressed code-mode startup notice is accepted once before the turn", () => {
  const notice = { type: "item.completed", item: { type: "error",
    message: "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install or update TRAE CLI (`traecli`)." } };
  const events = new (ExecEvents as any)({ codeModeHostDisabled: true });
  assert.doesNotThrow(() => events.accept(notice));
  events.accept({ type: "turn.started" });
  events.accept({ type: "item.completed", item: { type: "agent_message", text: '{"summary":"OK","actions":[]}' } });
  events.accept({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(events.finish().text, '{"summary":"OK","actions":[]}');
  assert.throws(() => new ExecEvents().accept(notice), { code: "isolation_violation" });
  const repeated = new (ExecEvents as any)({ codeModeHostDisabled: true });
  repeated.accept(notice);
  assert.throws(() => repeated.accept(notice), { code: "isolation_violation" });
  const late = new (ExecEvents as any)({ codeModeHostDisabled: true });
  late.accept({ type: "turn.started" });
  assert.throws(() => late.accept(notice), { code: "isolation_violation" });
  assert.throws(() => new (ExecEvents as any)({ codeModeHostDisabled: true }).accept({
    type: "item.completed", item: { type: "error", message: notice.item.message + " PRIVATE" },
  }), { code: "isolation_violation" });
});
