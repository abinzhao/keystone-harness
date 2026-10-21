import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chooseFolder, folderPickerSupported } from "../src/folder-picker.ts";

test("native controls build and self-test actual menus and panels without opening GUI", {
  skip: process.platform !== "darwin",
}, async () => {
  const source = fileURLToPath(new URL("../src-native/KeystoneWindow.swift", import.meta.url));
  assert.match(await readFile(source, "utf8"), /--self-test/, "headless self-test is required before launching helper");
  const home = await mkdtemp(join(tmpdir(), "keystone-native-controls-"));
  try {
    const binary = join(home, "window");
    const exec = promisify(execFile);
    await exec("swiftc", [source, "-o", binary, "-framework", "Cocoa", "-framework", "WebKit"], { timeout: 120_000 });
    const { stdout } = await exec(binary, ["--self-test"], { timeout: 20_000 });
    assert.deepEqual(JSON.parse(stdout), { ok: true, checks: 6, backend: "AppKit", gui: false });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("folder picker support requires the actual helper and cancellation stays distinct", async () => {
  const missing = join(tmpdir(), "keystone-no-folder-helper");
  assert.equal(folderPickerSupported({ helperPath: missing }), false);
  assert.equal((await chooseFolder("Choose", { helperPath: missing })).supported, false);
  if (process.platform !== "darwin") return;
  const calls: string[][] = [];
  const result = await chooseFolder("Choose", { helperPath: process.execPath,
    invoke: async (_path, args) => {
      calls.push([...args]);
      return { stdout: JSON.stringify({ supported: true, cancelled: true }) };
    },
  });
  assert.deepEqual(result, { supported: true, cancelled: true });
  assert.deepEqual(calls, [["--pick-folder", "--prompt", "Choose"]]);
  const malformed = await chooseFolder("Choose", {
    helperPath: process.execPath, invoke: async () => ({ stdout: "not-json-with-fixture-secret" }),
  });
  assert.equal(malformed.supported, true);
  assert.equal(malformed.error?.includes("fixture-secret"), false);
});
