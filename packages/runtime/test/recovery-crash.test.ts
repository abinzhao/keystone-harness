import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSequenceAdapter, scriptedModelDescriptor } from "@keystone/models";
import { KernelSession } from "@keystone/kernel";
import { KeystoneRuntime } from "../src/keystone-runtime.ts";
import { envelopeFor, FINISH_ACTION, makeFixture, removeFixture } from "./fixture.ts";

test("SIGKILL and a fresh runtime continue the durable task without replaying its write", { timeout: 20000 }, async () => {
  const fixture = await makeFixture();
  const marker = join(fixture.home, "task-marker");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/recovery-crash-worker.ts", import.meta.url)),
    fixture.root, fixture.home, marker], { stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR } });
  let failure = "";
  child.stderr!.on("data", (data: Buffer) => { failure += data.toString().slice(0, 2000); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("message", () => resolve());
      child.on("error", reject);
      child.on("exit", () => reject(new Error(`crash worker exited before checkpoint: ${failure}`)));
    });
    const dead = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await dead;
    const taskId = (await readFile(marker, "utf8")).trim();
    const runtime = await KeystoneRuntime.create({ paths: fixture.paths, models: [
      createSequenceAdapter({ descriptor: scriptedModelDescriptor({ id: "builder" }), responses: [envelopeFor([FINISH_ACTION])] }),
    ] });
    const result = await runtime.resumeTask(taskId);
    assert.equal(result.status, "proven");
    const session = await KernelSession.open({ paths: fixture.paths, taskId: taskId as never });
    assert.equal(session.events().filter((event) => event.type === "action.executed" &&
      (event.payload.changedPaths as string[]).includes("src/auth/session.js")).length, 1);
    assert.ok(session.events().some((event) => event.type === "recovery.verified"));
  } finally { child.kill("SIGKILL"); await removeFixture(fixture); }
});
