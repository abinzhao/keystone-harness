import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("package native build stages the carrier bundle and Security helper", {
  skip: process.platform !== "darwin",
}, async () => {
  const script = fileURLToPath(new URL("../scripts/build-native.ts", import.meta.url));
  assert.ok(existsSync(script), "package-local native build entry must exist");
  const output = await mkdtemp(join(tmpdir(), "keystone-native-build-"));
  try {
    const exec = promisify(execFile);
    await exec(process.execPath, [script, "--out", output], { timeout: 120_000 });
    const app = join(output, "Keystone.app", "Contents");
    assert.match(await readFile(join(app, "Info.plist"), "utf8"), /net\.keystone\.window/);
    const window = join(app, "MacOS", "keystone-window");
    assert.deepEqual(JSON.parse((await exec(window, ["--self-test"])).stdout),
      { ok: true, checks: 6, backend: "AppKit", gui: false });
    const credentials = join(app, "Helpers", "keystone-credentials");
    assert.deepEqual(JSON.parse((await exec(credentials, ["--self-test"])).stdout),
      { ok: true, checks: 5, backend: "memory" });
  } finally { await rm(output, { recursive: true, force: true }); }
});
