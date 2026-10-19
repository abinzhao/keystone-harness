/**
 * Terminal rendering.
 *
 * The interesting property is alignment: with Chinese as the default language,
 * a key/value block mixes double-width localised labels with ASCII values, and
 * the colon must still land in one column.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOutput, displayWidth } from "../src/output.ts";

function capture(json = false): { output: ReturnType<typeof createOutput>; text: () => string } {
  let text = "";
  const output = createOutput({
    stdout: { write: (chunk: string) => ((text += chunk), true) },
    stderr: { write: () => true },
    json,
  });
  return { output, text: () => text };
}

test("display width counts CJK as two columns", () => {
  assert.equal(displayWidth("node"), 4);
  assert.equal(displayWidth("主目录"), 6);
  assert.equal(displayWidth("可写"), 4);
  assert.equal(displayWidth("a主b"), 4);
});

test("key/value rows align by display width, not code units", () => {
  const { output, text } = capture();
  output.keyValue({ 可写: "是", KEYSTONE_HOME: "/tmp/x" });

  const lines = text().trimEnd().split("\n");
  // The widest label is KEYSTONE_HOME (13 columns); both colons must agree.
  const colonColumns = lines.map((line) => displayWidth(line.slice(0, line.indexOf(" :"))));
  assert.deepEqual(colonColumns, [13, 13]);
});

test("detail is suppressed unless verbose is set", () => {
  const { output, text } = capture();
  output.detail("hash abc");
  assert.equal(text(), "");
});
