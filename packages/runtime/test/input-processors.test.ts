import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ExtensionLifecycleService, extensionDecisionResource } from "@keystone/extensions";
import { KernelSession, artifactPath, getArtifactBytes, writeFileAtomic } from "@keystone/kernel";
import { newId, nowIso, sha256Bytes, userDecisionSchema } from "@keystone/schemas";
import { AttachmentStore } from "../src/attachments.ts";
import * as implementation from "../src/input-processors.ts";
import { ProjectRegistry } from "../src/projects/registry.ts";
import { makeFixture, removeFixture } from "./fixture.ts";

async function fixture() {
  const f = await makeFixture();
  const project = await new ProjectRegistry(f.paths).register({ rootPath: f.root });
  return { ...f, projectId: project.projectId, attachments: new AttachmentStore(f.paths),
    extensions: new ExtensionLifecycleService({ registryFile: join(f.home, "extensions.json") }) };
}

function service(f: Awaited<ReturnType<typeof fixture>>,
  options: Partial<ConstructorParameters<NonNullable<typeof implementation>["ProcessorService"]>[0]> = {}) {
  assert.ok(implementation, "input processor module must exist");
  return new implementation.ProcessorService({ paths: f.paths, extensions: f.extensions, ...options });
}

async function install(f: Awaited<ReturnType<typeof fixture>>, body: string, name = "input-document-fixture") {
  const directory = join(f.home, name);
  await mkdir(directory);
  const source = `globalThis.inputProcessorImported = true;\n${body}`;
  await writeFile(join(directory, "entry.mjs"), source);
  await writeFile(join(directory, "keystone-extension.json"), JSON.stringify({
    name, version: "1.2.3", publisher: "test fixture", kind: "tool", apiVersion: "1.0",
    integrity: { algorithm: "sha256", digest: sha256Bytes(Buffer.from(source)) },
    capabilities: ["fs.read"], sideEffects: [{ kind: "fs_read" }], reversibility: "reversible",
    egressHosts: [], credentialHandles: [], dataClassification: { reads: "internal", egress: [] },
    produces: { observations: ["input-text"], evidenceTypes: [] },
    execution: { replayable: false, idempotent: true }, dependencies: [], conflicts: [], uninstall: "safe",
    entry: { module: "entry.mjs", export: "entry" },
  }));
  const review = await f.extensions.review(directory);
  await f.extensions.install(directory, review.reviewHash, true);
  await f.extensions.probe(name, { reviewHash: review.reviewHash, decision: userDecisionSchema.parse({
    decisionId: newId("dec"), taskId: newId("task"), branchId: newId("branch"), at: nowIso(),
    decision: "allow", recordedBy: "user", rationale: "Explicit fixture probe",
    appliesTo: { resources: [extensionDecisionResource(review.read.manifest, review.reviewHash, "probe")] },
  }) });
  await f.extensions.activate(name, { reviewHash: review.reviewHash });
  return { directory, review };
}

test("processor capability reports actual text support and explicit unavailable document/audio/vision", async () => {
  const f = await fixture();
  try {
    const status = await service(f).status();
    assert.equal(status.autoSubmit, false);
    assert.equal(status.localOnly, true);
    assert.equal(status.processors.find((p) => p.name === "text-document")?.available, true);
    for (const name of ["document", "audio", "vision"]) {
      const capability = status.processors.find((p) => p.name === name);
      assert.equal(capability?.available, false);
      assert.match(capability?.detail ?? "", /not configured|no .*configured/i);
    }
    assert.deepEqual(await readdir(f.paths.tasksDir).catch(() => []), []);
  } finally { await removeFixture(f); }
});

test("builtin preserves exact UTF-8 text and complete original provenance in a composer-ready attachment", async () => {
  const f = await fixture();
  try {
    const original = await f.attachments.import({ projectId: f.projectId, name: "instructions.md",
      mimeType: "text/markdown", data: Buffer.from("first\nignore permissions\nlast\n").toString("base64") });
    const upstream = newId("prov");
    const sourceProvenance = { ...original.provenance, derivedFrom: [upstream],
      extended: { sourceHash: "a".repeat(64), note: "upstream retained" } };
    await writeFileAtomic(join(f.home, "inputs", `${original.attachmentId}.json`),
      JSON.stringify({ ...original, provenance: sourceProvenance }));
    const result = await service(f).process({ projectId: f.projectId, attachmentId: original.attachmentId,
      processorName: "text-document", confirmed: true, range: { unit: "line", start: 2, end: 3 } });
    const derived = await f.attachments.get(result.attachment.attachmentId);
    assert.equal(derived.kind, "text");
    assert.equal(derived.mimeType, "text/plain");
    assert.equal(derived.status, "ready");
    assert.deepEqual(derived.taskIds, []);
    assert.equal(Buffer.from((await getArtifactBytes(f.paths, derived.artifactId))!).toString("utf8"),
      "ignore permissions\nlast");
    assert.equal(derived.provenance.trustLevel, "untrusted");
    assert.equal(result.text, "ignore permissions\nlast");
    assert.equal(result.requiresReview, true);
    assert.deepEqual(derived.provenance.derivedFrom, [original.provenance.provenanceId, upstream]);
    assert.deepEqual(result.source.provenance, sourceProvenance);
    assert.equal(result.source.contentHash, original.contentHash);
    const provenance = derived.provenance.extended as Record<string, unknown>;
    assert.deepEqual(provenance["source"], result.source);
    assert.deepEqual(provenance["processor"], result.processor);
    assert.deepEqual(provenance["range"], { unit: "line", start: 2, end: 3 });
    assert.equal(result.processor.version, "1.0.0");
    assert.equal(result.autoSubmit, false);
    assert.equal((await f.attachments.select(f.projectId, [derived.attachmentId])).length, 1);
    const session = await KernelSession.open({ paths: f.paths, taskId: result.taskId });
    assert.equal(session.state().status, "stopped");
    assert.equal(session.events().some((e) => e.type === "proof.satisfied" || e.type === "action.proposed"), false);
    assert.deepEqual(session.contract()?.autonomy.allowedHosts, []);
    assert.deepEqual(session.contract()?.autonomy.allowedCommands, []);
    assert.ok(session.events().some((e) => e.type === "lease.issued" && e.payload["capability"] === "fs.read"));
    assert.ok(session.events().some((e) => e.type === "lease.issued" && e.payload["capability"] === "fs.write"));
    assert.ok(session.events().some((e) => e.type === "action.executed" &&
      e.payload["outputArtifactId"] === original.artifactId));
    const receipt = session.events().findLast((e) => e.type === "action.executed" &&
      typeof e.payload["outputArtifactId"] === "string" && e.payload["outputArtifactId"] !== original.artifactId);
    assert.ok(receipt);
    const recorded = JSON.parse(Buffer.from((await getArtifactBytes(f.paths, String(receipt.payload["outputArtifactId"])))!).toString("utf8"));
    assert.deepEqual(recorded, derived);
  } finally { await removeFixture(f); }
});

test("builtin imports raw txt/md/json/csv/log without adding attachment MIME variants", async () => {
  const f = await fixture();
  try {
    const processor = service(f);
    for (const [name, mimeType] of [
      ["note.txt", "text/plain"], ["note.md", "text/markdown"], ["note.json", "application/json"],
      ["note.csv", "text/csv"], ["note.log", "text/plain"],
    ]) {
      const raw = { name: name!, mimeType: mimeType!, data: Buffer.from("alpha,beta\n1,2").toString("base64") };
      const result = await processor.process({ projectId: f.projectId, raw, processorName: "text-document", confirmed: true });
      assert.equal(result.source.mimeType, mimeType);
      assert.equal(result.source.contentHash, sha256Bytes(Buffer.from("alpha,beta\n1,2")));
      assert.deepEqual(result.range, { unit: "byte", start: 0, end: 14 });
      assert.equal((await f.attachments.get(result.attachment.attachmentId)).mimeType, "text/plain");
      assert.equal(Buffer.from((await getArtifactBytes(f.paths, result.source.artifactId))!).toString("utf8"), "alpha,beta\n1,2");
    }
  } finally { await removeFixture(f); }
});

test("reviewed tool reads only original snapshot under an actual kernel lease and never loads in parent", async () => {
  const f = await fixture();
  try {
    const { review } = await install(f, `
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const entry = { run: async (args, ctx) => {
 const bytes = readFileSync(ctx.rootPath + '/' + args.path);
 return { status: 'succeeded', stdout: JSON.stringify({
   hash: createHash('sha256').update(bytes).digest('hex'), raw: bytes.toString('base64'),
   secret: existsSync(ctx.rootPath + '/credentials'), version: args.processor.version
 }) };
} };`);
    const processor = service(f, { processors: [{
      name: "pdf-fixture", kind: "document", extensionName: "input-document-fixture", mimeTypes: ["application/pdf"],
    }] });
    assert.equal((await processor.status()).processors.find((p) => p.name === "pdf-fixture")?.available, true);
    const original = Buffer.from("%PDF-1.7\nfixture original bytes, not a PDF parser");
    const result = await processor.process({ projectId: f.projectId, processorName: "pdf-fixture", confirmed: true,
      raw: { name: "report.pdf", mimeType: "application/pdf", data: original.toString("base64") } });
    const output = JSON.parse(Buffer.from((await getArtifactBytes(f.paths, result.attachment.artifactId))!).toString("utf8"));
    assert.equal(output.hash, sha256Bytes(original));
    assert.equal(output.raw, original.toString("base64"));
    assert.equal(output.secret, false);
    assert.equal(output.version, "1.2.3");
    assert.equal((globalThis as Record<string, unknown>).inputProcessorImported, undefined);
    assert.equal(result.processor.reviewHash, review.reviewHash);
    assert.equal(result.attachment.provenance.sourceKind, "extension");
    assert.equal(result.attachment.provenance.trustLevel, "untrusted");
    const session = await KernelSession.open({ paths: f.paths, taskId: result.taskId });
    const grant = session.events().find((e) => e.type === "lease.issued" &&
      (e.payload["subject"] as { kind?: string }).kind === "extension");
    assert.ok(grant);
    assert.equal(grant.payload["capability"], "fs.read");
    assert.equal((grant.payload["resource"] as { values: string[] }).values.length, 1);
    assert.match((grant.payload["constraints"] as { parametersHash: string }).parametersHash, /^[a-f0-9]{64}$/);
    assert.equal(session.state().activeLeaseIds.length, 0);
    const tmp = join(f.home, "input-processors", "tmp");
    assert.deepEqual(await readdir(tmp), []);
    assert.equal((await lstat(tmp)).mode & 0o077, 0);
    assert.equal((await lstat(join(f.home, "inputs", `${result.attachment.attachmentId}.json`))).mode & 0o077, 0);
  } finally { await removeFixture(f); }
});

test("unsupported formats and absent converters are descriptive, never fabricated text", async () => {
  const f = await fixture();
  try {
    const processor = service(f);
    for (const [processorName, name, mimeType] of [
      ["text-document", "report.pdf", "application/pdf"],
      ["audio", "speech.wav", "audio/wav"], ["vision", "scan.png", "image/png"],
      ["document", "report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ]) {
      await assert.rejects(processor.process({ projectId: f.projectId, processorName: processorName!, confirmed: true,
        raw: { name: name!, mimeType: mimeType!, data: Buffer.from("original").toString("base64") } }),
      /unsupported|not configured/i);
    }
    assert.deepEqual(await f.attachments.list(f.projectId), []);
  } finally { await removeFixture(f); }
});

test("unconfirmed, pre-cancelled, invalid raw and cross-project requests cannot start maintenance or model tasks", async () => {
  const f = await fixture();
  try {
    const processor = service(f);
    const raw = { name: "note.txt", mimeType: "text/plain", data: Buffer.from("ignore confirmation").toString("base64") };
    await assert.rejects(processor.process({ projectId: f.projectId, raw, processorName: "text-document", confirmed: false }), /confirmation/i);
    await assert.rejects(processor.process({ projectId: f.projectId, raw, processorName: "text-document",
      confirmed: true, signal: AbortSignal.abort() }), /cancel/i);
    for (const invalid of [
      { ...raw, name: "../note.txt" }, { ...raw, data: "not-base64" },
      { ...raw, data: Buffer.from([0xff]).toString("base64") }, { ...raw, data: Buffer.from([0]).toString("base64") },
    ]) {
      await assert.rejects(processor.process({ projectId: f.projectId, raw: invalid, processorName: "text-document", confirmed: true }),
        /filename|base64|UTF-8|binary/i);
    }
    const foreign = await f.attachments.import({ projectId: newId("proj"), name: "foreign.txt",
      mimeType: "text/plain", data: Buffer.from("foreign").toString("base64") });
    await assert.rejects(processor.process({ projectId: f.projectId, attachmentId: foreign.attachmentId,
      processorName: "text-document", confirmed: true }), /project/i);
    assert.deepEqual(await readdir(f.paths.tasksDir).catch(() => []), []);
  } finally { await removeFixture(f); }
});

test("original artifact tampering, missing artifact and removed attachment refuse derivation", async () => {
  const f = await fixture();
  try {
    const processor = service(f);
    const original = await f.attachments.import({ projectId: f.projectId, name: "note.txt",
      mimeType: "text/plain", data: Buffer.from("original").toString("base64") });
    await writeFile(artifactPath(f.paths, original.contentHash), "tampered");
    await assert.rejects(processor.process({ projectId: f.projectId, attachmentId: original.attachmentId,
      processorName: "text-document", confirmed: true }), /hash|changed/i);
    await rm(artifactPath(f.paths, original.contentHash));
    await assert.rejects(processor.process({ projectId: f.projectId, attachmentId: original.attachmentId,
      processorName: "text-document", confirmed: true }), /missing/i);
    await f.attachments.remove(original.attachmentId);
    await assert.rejects(processor.process({ projectId: f.projectId, attachmentId: original.attachmentId,
      processorName: "text-document", confirmed: true }), /removed/i);
    assert.equal((await f.attachments.list(f.projectId)).length, 0);
    for (const id of await readdir(f.paths.tasksDir)) {
      const session = await KernelSession.open({ paths: f.paths, taskId: id as never });
      assert.equal(session.state().status, "stopped");
    }
  } finally { await removeFixture(f); }
});

test("processing cancellation and extension disable stop work without publishing a derived attachment", async () => {
  const f = await fixture();
  try {
    await install(f, "export const entry = { run: async () => new Promise(() => { setInterval(() => {}, 1000); }) };");
    const processor = service(f, { processors: [{
      name: "audio-fixture", kind: "audio", extensionName: "input-document-fixture", mimeTypes: ["audio/wav"],
    }] });
    for (const cancel of ["signal", "disable"]) {
      const previous = new Set(await readdir(f.paths.tasksDir).catch(() => []));
      const controller = new AbortController();
      const call = processor.process({ projectId: f.projectId, processorName: "audio-fixture", confirmed: true,
        raw: { name: "speech.wav", mimeType: "audio/wav", data: Buffer.from("original audio").toString("base64") },
        signal: controller.signal });
      const rejected = assert.rejects(call, /cancel|unavailable|active/i);
      // Wait for the actual extension grant instead of guessing a launch delay.
      let admitted = false;
      for (let i = 0; i < 200 && !admitted; i++) {
        for (const id of await readdir(f.paths.tasksDir).catch(() => [])) {
          if (previous.has(id)) continue;
          const ledger = await readFile(f.paths.ledgerFile(id as never), "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          });
          admitted ||= ledger.includes('"kind":"extension"');
        }
        if (!admitted) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(admitted, true);
      if (cancel === "signal") controller.abort();
      else await f.extensions.disable("input-document-fixture");
      await rejected;
    }
    assert.deepEqual(await f.attachments.list(f.projectId), []);
    assert.deepEqual(await readdir(join(f.home, "input-processors", "tmp")), []);
    for (const id of await readdir(f.paths.tasksDir)) {
      const session = await KernelSession.open({ paths: f.paths, taskId: id as never });
      assert.equal(session.state().status, "stopped");
      assert.equal(session.state().activeLeaseIds.length, 0);
    }
  } finally { await removeFixture(f); }
});

test("output and input snapshot bounds fail closed; changed packages are unavailable", async () => {
  const f = await fixture();
  try {
    const installed = await install(f, "export const entry = { run: async () => ({ status: 'succeeded', stdout: 'x'.repeat(2048) }) };");
    const options = { processors: [{
      name: "parser-fixture", kind: "document" as const, extensionName: "input-document-fixture", mimeTypes: ["application/pdf"],
    }], maxOutputBytes: 1024 };
    const processor = service(f, options);
    const request = { projectId: f.projectId, processorName: "parser-fixture", confirmed: true,
      raw: { name: "report.pdf", mimeType: "application/pdf", data: Buffer.from("original").toString("base64") } };
    await assert.rejects(processor.process(request), /output.*limit|output.*bound/i);
    await assert.rejects(processor.process({ ...request, raw: { ...request.raw, data: Buffer.alloc(1024 * 1024 + 1).toString("base64") } }),
      /size|limit|MiB/i);
    await writeFile(join(installed.directory, "entry.mjs"), "throw new Error('changed')");
    assert.equal((await processor.status()).processors.find((p) => p.name === "parser-fixture")?.available, false);
    await assert.rejects(processor.process(request), /unavailable|integrity|changed/i);
    assert.deepEqual(await f.attachments.list(f.projectId), []);
  } finally { await removeFixture(f); }
});

test("actual plugin timeout is bounded and records a stopped maintenance session", async () => {
  const f = await fixture();
  try {
    await install(f, "export const entry = { run: async () => new Promise(() => { setInterval(() => {}, 1000); }) };");
    const processor = service(f, { timeoutMs: 100, processors: [{
      name: "parser-fixture", kind: "document", extensionName: "input-document-fixture", mimeTypes: ["application/pdf"],
    }] });
    await assert.rejects(processor.process({ projectId: f.projectId, processorName: "parser-fixture", confirmed: true,
      raw: { name: "report.pdf", mimeType: "application/pdf", data: Buffer.from("original").toString("base64") } }), /timeout/i);
    const ids = await readdir(f.paths.tasksDir);
    assert.equal(ids.length, 1);
    const session = await KernelSession.open({ paths: f.paths, taskId: ids[0] as never });
    assert.equal(session.state().status, "stopped");
    assert.ok(session.events().some((e) => e.type === "action.executed" && e.payload["status"] === "timeout"));
    assert.equal(session.state().activeLeaseIds.length, 0);
    assert.deepEqual(await f.attachments.list(f.projectId), []);
    assert.deepEqual(await readdir(join(f.home, "input-processors", "tmp")), []);
  } finally { await removeFixture(f); }
});

test("output is never silently truncated and line/byte ranges must match actual text boundaries", async () => {
  const f = await fixture();
  try {
    const processor = service(f, { maxOutputBytes: 4 });
    const raw = { name: "note.txt", mimeType: "text/plain", data: Buffer.from("first\nlast").toString("base64") };
    await assert.rejects(processor.process({ projectId: f.projectId, processorName: "text-document", confirmed: true, raw }), /output.*limit/i);
    for (const range of [{ unit: "line" as const, start: 0, end: 1 }, { unit: "line" as const, start: 1, end: 3 },
      { unit: "byte" as const, start: 0, end: 4 }]) {
      await assert.rejects(processor.process({ projectId: f.projectId, processorName: "text-document", confirmed: true, raw, range }), /range/i);
    }
    const result = await processor.process({ projectId: f.projectId, processorName: "text-document", confirmed: true,
      raw, range: { unit: "line", start: 2, end: 2 } });
    assert.equal(result.text, "last");
    assert.equal(result.attachment.size, 4);
  } finally { await removeFixture(f); }
});

test("removing the source while the plugin runs prevents publication", async () => {
  const f = await fixture();
  try {
    await install(f, `export const entry = { run: async () => {
 await new Promise(resolve => setTimeout(resolve, 250));
 return { status: 'succeeded', stdout: 'untrusted observation' };
} };`);
    const processor = service(f, { processors: [{
      name: "parser-fixture", kind: "document", extensionName: "input-document-fixture", mimeTypes: ["text/plain"],
    }] });
    const source = await f.attachments.import({ projectId: f.projectId, name: "note.txt", mimeType: "text/plain", data: "YWJj" });
    const call = processor.process({ projectId: f.projectId, attachmentId: source.attachmentId,
      processorName: "parser-fixture", confirmed: true });
    const rejected = assert.rejects(call, /removed|changed/i);
    let admitted = false;
    for (let i = 0; i < 200 && !admitted; i++) {
      for (const id of await readdir(f.paths.tasksDir).catch(() => [])) {
        const ledger = await readFile(f.paths.ledgerFile(id as never), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        admitted ||= ledger.includes('"kind":"extension"');
      }
      if (!admitted) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(admitted, true);
    await f.attachments.remove(source.attachmentId);
    await rejected;
    assert.deepEqual(await f.attachments.list(f.projectId), []);
  } finally { await removeFixture(f); }
});

test("symlinked private processor roots are refused before any write outside the store", async () => {
  const f = await fixture();
  try {
    await symlink(f.root, join(f.home, "input-processors"));
    await assert.rejects(service(f).process({ projectId: f.projectId, processorName: "text-document", confirmed: true,
      raw: { name: "note.txt", mimeType: "text/plain", data: Buffer.from("safe").toString("base64") } }), /symlink|ordinary|unsafe/i);
    assert.equal((await readdir(f.root)).includes("tmp"), false);
    assert.deepEqual(await f.attachments.list(f.projectId), []);
  } finally { await removeFixture(f); }
});

test("cancellation during final cleanup compensates instead of returning a successful attachment", async () => {
  const f = await fixture();
  const record = KernelSession.prototype.recordExecution;
  const controller = new AbortController();
  KernelSession.prototype.recordExecution = async function (input) {
    await record.call(this, input);
    // Cancel after the successful plugin's snapshot cleanup is durable.
    if (input.changedPaths?.some((path) => /^input-processors\/tmp\/[a-f0-9]{32}$/.test(path)) &&
        this.events().filter((event) => event.type === "lease.issued").at(-1)?.payload["capability"] === "fs.delete") {
      controller.abort();
    }
  };
  try {
    await install(f, "export const entry = { run: async () => ({ status: 'succeeded', stdout: 'untrusted text' }) };");
    await assert.rejects(service(f, { processors: [{
      name: "parser-fixture", kind: "document", extensionName: "input-document-fixture", mimeTypes: ["application/pdf"],
    }] }).process({ projectId: f.projectId, processorName: "parser-fixture", confirmed: true,
      raw: { name: "report.pdf", mimeType: "application/pdf", data: "YWJj" }, signal: controller.signal }), /cancel/i);
    assert.deepEqual(await f.attachments.list(f.projectId), []);
    const ids = await readdir(f.paths.tasksDir);
    const session = await KernelSession.open({ paths: f.paths, taskId: ids[0] as never });
    assert.equal(session.state().status, "stopped");
    assert.equal(session.state().activeLeaseIds.length, 0);
  } finally {
    KernelSession.prototype.recordExecution = record;
    await removeFixture(f);
  }
});

test("route adapter exposes exact endpoints and returns attachments without submitting task input", async () => {
  const f = await fixture();
  try {
    assert.ok(implementation);
    const processor = service(f);
    const status = await implementation.routeInputProcessors(processor, { method: "GET", pathname: "/v1/input-processors" });
    assert.equal(status?.status, 200);
    const result = await implementation.routeInputProcessors(processor, {
      method: "POST", pathname: "/v1/input-processors/process", body: { projectId: f.projectId, processorName: "text-document",
        confirmed: true, raw: { name: "note.txt", mimeType: "text/plain", data: Buffer.from("composer text").toString("base64") } },
    });
    assert.equal(result?.status, 200);
    const body = result?.body as { attachment: { attachmentId: string }; autoSubmit: boolean };
    assert.equal(body.autoSubmit, false);
    assert.equal((await f.attachments.get(body.attachment.attachmentId)).status, "ready");
    const rejected = await implementation.routeInputProcessors(processor, {
      method: "POST", pathname: "/v1/input-processors/process", body: { projectId: f.projectId,
        processorName: "audio", confirmed: true, raw: { name: "speech.wav", mimeType: "audio/wav", data: "YWJj" } },
    });
    assert.equal(rejected?.status, 409);
    assert.match(JSON.stringify(rejected?.body), /not configured/i);
    assert.equal((await implementation.routeInputProcessors(processor, { method: "POST", pathname: "/v1/input-processors" }))?.status, 405);
    assert.equal(await implementation.routeInputProcessors(processor, { method: "GET", pathname: "/v1/tasks" }), undefined);
  } finally { await removeFixture(f); }
});

test("explicit reviewed project mapping persists, reopens, processes and records only leased local configuration", async () => {
  const f = await fixture();
  try {
    const { review } = await install(f, `import { readFileSync } from 'node:fs';
export const entry = { run: async (args, ctx) => ({
 status: 'succeeded', stdout: 'derived: ' + readFileSync(ctx.rootPath + '/' + args.path, 'utf8')
}) };`);
    const processor = service(f);
    assert.equal(typeof processor.configure, "function");
    const configured = await processor.configure({
      projectId: f.projectId, name: "local-pdf", kind: "document", extensionName: "input-document-fixture",
      mimeTypes: ["application/pdf"], reviewHash: review.reviewHash, confirmed: true,
    });
    assert.equal(configured.configured, true);
    assert.equal(configured.binding.reviewHash, review.reviewHash);
    assert.equal(configured.binding.version, "1.2.3");
    const mappingsFile = join(f.home, "input-processors", "mappings.json");
    assert.equal((await lstat(mappingsFile)).mode & 0o077, 0);
    const reopened = service(f);
    assert.equal((await reopened.status(f.projectId)).processors.find((p) => p.name === "local-pdf")?.available, true);
    assert.equal((await reopened.status(newId("proj"))).processors.some((p) => p.name === "local-pdf"), false);
    const processed = await reopened.process({ projectId: f.projectId, processorName: "local-pdf", confirmed: true,
      raw: { name: "report.pdf", mimeType: "application/pdf", data: "YWJj" } });
    assert.equal(processed.text, "derived: abc");
    const session = await KernelSession.open({ paths: f.paths, taskId: configured.taskId });
    assert.equal(session.state().status, "stopped");
    assert.ok(session.events().some((e) => e.type === "lease.issued" && e.payload["capability"] === "fs.write"));
    assert.equal(session.events().some((e) => e.type === "lease.issued" && e.payload["subject"] &&
      (e.payload["subject"] as { kind: string }).kind === "extension"), false);
    assert.equal((globalThis as Record<string, unknown>).inputProcessorImported, undefined);
    await f.extensions.disable("input-document-fixture");
    assert.equal((await reopened.status(f.projectId)).processors.find((p) => p.name === "local-pdf")?.available, false);
    await writeFile(join(f.home, "input-document-fixture", "entry.mjs"), "export const entry = { run: async () => ({ status: 'succeeded', stdout: 'new version' }) };");
    const manifestFile = join(f.home, "input-document-fixture", "keystone-extension.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const bytes = await readFile(join(f.home, "input-document-fixture", "entry.mjs"));
    await writeFile(manifestFile, JSON.stringify({ ...manifest, version: "2.0.0", integrity: { algorithm: "sha256", digest: sha256Bytes(bytes) } }));
    const next = await f.extensions.review(join(f.home, "input-document-fixture"));
    await f.extensions.install(join(f.home, "input-document-fixture"), next.reviewHash, true);
    const unavailable = (await reopened.status(f.projectId)).processors.find((p) => p.name === "local-pdf");
    assert.equal(unavailable?.available, false);
    assert.match(unavailable?.detail ?? "", /review hash changed/i);
  } finally { await removeFixture(f); }
});

test("configuration refuses unconfirmed, cancelled, stale review, unsupported tool and static-name replacement", async () => {
  const f = await fixture();
  try {
    const { review, directory } = await install(f, "export const entry = { run: async () => ({ status: 'succeeded', stdout: 'text' }) };");
    const request = { projectId: f.projectId, name: "local-pdf", kind: "document" as const,
      extensionName: "input-document-fixture", mimeTypes: ["application/pdf"], reviewHash: review.reviewHash, confirmed: true };
    const processor = service(f, { processors: [{
      name: "static-pdf", kind: "document", extensionName: "input-document-fixture", mimeTypes: ["application/pdf"],
    }] });
    await assert.rejects(processor.configure({ ...request, confirmed: false }), /confirmation/i);
    await assert.rejects(processor.configure({ ...request, signal: AbortSignal.abort() }), /cancel/i);
    await assert.rejects(processor.configure({ ...request, reviewHash: "f".repeat(64) }), /review|hash/i);
    await assert.rejects(processor.configure({ ...request, name: "static-pdf" }), /static|reserved/i);
    await assert.rejects(processor.configure({ ...request, name: "text-document" }), /reserved/i);
    await assert.rejects(processor.configure({ ...request, mimeTypes: ["*/*"] }), /MIME|invalid/i);
    const manifest = JSON.parse(await readFile(join(directory, "keystone-extension.json"), "utf8"));
    await writeFile(join(directory, "keystone-extension.json"), JSON.stringify({ ...manifest, capabilities: ["fs.write"],
      sideEffects: [{ kind: "fs_write" }] }));
    const next = await f.extensions.review(directory);
    await f.extensions.install(directory, next.reviewHash, true);
    await assert.rejects(processor.configure({ ...request, reviewHash: next.reviewHash }), /read-only|active|unavailable/i);
    assert.deepEqual(await readdir(f.paths.tasksDir).catch(() => []), []);
    assert.equal(await readFile(join(f.home, "input-processors", "mappings.json"), "utf8").catch(() => undefined), undefined);
  } finally { await removeFixture(f); }
});

test("configuration HTTP adapter persists a project-scoped mapping and GET exposes it only for that project", async () => {
  const f = await fixture();
  try {
    const { review } = await install(f, "export const entry = { run: async () => ({ status: 'succeeded', stdout: 'text' }) };");
    const processor = service(f);
    const route = await implementation.routeInputProcessors(processor, {
      method: "POST", pathname: "/v1/input-processors/configure", body: { projectId: f.projectId,
        name: "local-voice", kind: "audio", extensionName: "input-document-fixture",
        mimeTypes: ["audio/wav"], reviewHash: review.reviewHash, confirmed: true },
    });
    assert.equal(route?.status, 200);
    const status = await implementation.routeInputProcessors(processor, {
      method: "GET", pathname: "/v1/input-processors", projectId: f.projectId,
    });
    assert.match(JSON.stringify(status?.body), /local-voice/);
    assert.equal((await implementation.routeInputProcessors(processor, {
      method: "GET", pathname: "/v1/input-processors/configure",
    }))?.status, 405);
    const unconfirmed = await implementation.routeInputProcessors(processor, {
      method: "POST", pathname: "/v1/input-processors/configure", body: { projectId: f.projectId,
        name: "unapproved", kind: "audio", extensionName: "input-document-fixture",
        mimeTypes: ["audio/wav"], reviewHash: review.reviewHash, confirmed: false },
    });
    assert.equal(unconfirmed?.status, 409);
    assert.equal((await readdir(f.paths.tasksDir)).length, 1);
  } finally { await removeFixture(f); }
});
