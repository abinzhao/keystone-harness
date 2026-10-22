import assert from "node:assert/strict";
import test from "node:test";
import { parseActionEnvelope } from "../src/prompt.ts";

test("Markdown code fences inside a valid JSON answer never replace the outer envelope", () => {
  const answer = "## Result\n```js\nrefreshes += 1;\n```\nSee @src/session.js:4.";
  const envelope = { summary: "Code explanation", answer, actions: [] };
  assert.equal(parseActionEnvelope(JSON.stringify(envelope), "model").answer, answer);
  assert.equal(parseActionEnvelope("```json\n" + JSON.stringify(envelope) + "\n```", "model").answer, answer);
});
