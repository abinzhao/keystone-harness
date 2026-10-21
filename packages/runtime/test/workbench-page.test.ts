/**
 * Static guards for the workbench's safety and accessibility surface.
 *
 * The page is one dependency-free HTML file, so these tests read it as text and
 * assert the structural hooks a user (and a screen reader / keyboard user)
 * relies on. They do not run the UI; they pin the contract that the confirm
 * dialogs, focus management, terminal receipt and responsive layout must keep.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "web", "workbench.html");

async function page(): Promise<string> {
  return readFile(PAGE, "utf8");
}

test("the dialog is a labelled, modal dialog with focus management", async () => {
  const html = await page();
  assert.match(html, /<div id="modal"[^>]*role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="modal-title"/);
  // Focus is saved before open and restored after close.
  assert.match(html, /state\.lastFocus = document\.activeElement/);
  assert.match(html, /restore\.focus\(\)/);
  // Tab is trapped while the dialog is open.
  assert.match(html, /function trapModalFocus/);
  assert.match(html, /document\.addEventListener\("keydown"/);
});

test("destructive data actions ask for confirmation before they fire", async () => {
  const html = await page();
  assert.match(html, /function confirmAction/);
  // Two destructive actions (clear experience, delete task) each confirm first,
  // and each bails out without calling the API if the user declined.
  const confirmCount = html.split("await confirmAction(").length - 1;
  const bailCount = html.split("if (!ok) return;").length - 1;
  assert.ok(confirmCount >= 2, `expected at least two confirmations, found ${confirmCount}`);
  assert.ok(bailCount >= 2, `expected at least two declined-action bailouts, found ${bailCount}`);
  // Impact counts are carried so the confirmation can show what will be lost.
  assert.match(html, /data-entries=/);
  assert.match(html, /data-candidates=/);
  assert.match(html, /data-events=/);
  assert.match(html, /data-checkpoints=/);
});

test("a terminal-state receipt is rendered from existing data and never claims success on its own", async () => {
  const html = await page();
  assert.match(html, /function renderReceipt/);
  assert.match(html, /id="receipt"/);
  // Only the finished states render a receipt; working states do not.
  assert.match(html, /TERMINAL_STATUSES/);
  for (const status of ["proven", "exited_gracefully", "failed", "stopped", "unrecoverable"]) {
    assert.match(html, new RegExp(status));
  }
  // The receipt is a projection, not a fabricated success.
  assert.match(html, /state\.proof/);
  assert.match(html, /state\.detail/);
});

test("narrow windows collapse to a task-first single column with no horizontal overflow", async () => {
  const html = await page();
  assert.match(html, /@media \(max-width: 860px\)/);
  // The centre (goal/status) is the first visual block on narrow widths.
  const block = html.match(/@media \(max-width: 860px\) \{[\s\S]*?\n      \}/)?.[0] ?? "";
  assert.ok(block.includes('"centre"'), "the centre zone must participate in the narrow layout");
  assert.ok(block.indexOf('"centre"') < block.indexOf('"left"'), "centre must come before left visually");
  assert.match(block, /grid-template-columns: minmax\(0, 1fr\)/);
});

test("polling pauses while hidden and stale responses cannot clobber a new selection", async () => {
  const html = await page();
  assert.match(html, /document\.hidden/);
  assert.match(html, /visibilitychange/);
  // Both the load and the poll guard against a task id that changed mid-flight.
  assert.match(html, /if \(state\.taskId !== taskId\) return;/);
});

test("simple mode is the default and the four-zone advanced view is one toggle away", async () => {
  const html = await page();
  // A stored choice is honoured; otherwise it lands on simple.
  assert.match(html, /localStorage\.getItem\(MODE_KEY\) === "advanced"/);
  assert.match(html, /composer\.hidden = mode !== "simple"/);
  assert.match(html, /id="mode-toggle"/);
  // Simple mode hides the side columns; advanced keeps them.
  assert.match(html, /:root\[data-mode="simple"\] \.left/);
  assert.match(html, /:root\[data-mode="simple"\] \.right/);
});

test("a write task previews a readable contract and grades the start (ADR-0013)", async () => {
  const html = await page();
  // The gate function drafts a contract over the read-only preview route first.
  assert.match(html, /async function startTaskWithGate/);
  assert.match(html, /\/v1\/contract\/preview/);
  // Read-only tasks skip the write gate entirely; writes are graded.
  assert.match(html, /if \(writePaths\.length === 0\)/);
  // The server-authoritative grade drives three outcomes, not one binary modal.
  assert.match(html, /risk\.decision === "refuse"/);
  assert.match(html, /risk\.decision === "auto_start"/);
  assert.match(html, /I accept this scope/);
});

test("first-run onboarding collects a BYOK endpoint and validates it without echoing the key", async () => {
  const html = await page();
  assert.match(html, /id="onboarding"/);
  assert.match(html, /id="ob-base"/);
  assert.match(html, /id="ob-model"/);
  // The key field is a password input; the save/test routes never read it back.
  assert.match(html, /id="ob-key" type="password"/);
  assert.match(html, /\/desktop\/config\/test/);
  assert.match(html, /\/desktop\/config\/save/);
  // Onboarding appears only when the shell reports no configured model.
  assert.match(html, /state\.shell\.hasModel === false/);
});
