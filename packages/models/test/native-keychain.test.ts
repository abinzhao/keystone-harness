import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Security framework helper builds and exercises injected storage without touching Keychain", {
  skip: process.platform !== "darwin",
}, async () => {
  const source = fileURLToPath(new URL("../src-native/KeystoneCredentials.swift", import.meta.url));
  assert.ok(existsSync(source), "native credential helper must exist");
  const home = await mkdtemp(join(tmpdir(), "keystone-swift-credentials-"));
  try {
    const binary = join(home, "credentials");
    const exec = promisify(execFile);
    await exec("swiftc", [source, "-o", binary, "-framework", "Security"], { timeout: 120_000 });
    const { stdout } = await exec(binary, ["--self-test"]);
    assert.deepEqual(JSON.parse(stdout), { ok: true, checks: 5, backend: "memory" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
