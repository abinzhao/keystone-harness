import assert from "node:assert/strict";
import test from "node:test";
import { access, realpath, rm, appendFile } from "node:fs/promises";
import { createTransport, executeTransport } from "../src/transport.ts";
import { nativeFixture, lease } from "./fixtures.ts";

const options = { cliPath: process.execPath, endpointHost: "api.example.com", egressHosts: ["api.example.com"],
  isActive: () => true, checkIntegrity: () => true };

test("prepare creates no directories; rejected authorization never starts process or setup", {
  skip: process.platform !== "darwin",
}, async () => {
  const transport = await createTransport(options);
  const prepared = transport.prepare("version", ["-e", "console.log(123)"]);
  assert.equal(prepared.proposal.parameters.command, "/usr/bin/sandbox-exec");
  assert.equal(prepared.proposal.parameters.sourceExecutable, await realpath(process.execPath));
  assert.ok(prepared.proposal.parameters.args.includes(prepared.proposal.parameters.temporaryRoot + "/traex"));
  assert.equal(prepared.proposal.parameters.cwd, prepared.proposal.parameters.temporaryRoot + "/work");
  await assert.rejects(access(prepared.proposal.parameters.cwd));
  await assert.rejects(prepared.execute(async () => { throw new Error("PRIVATE rejected"); }), { code: "authorization" });
  await assert.rejects(access(prepared.proposal.parameters.cwd));
});

test("exact authorization launches only confined process and removes private setup", {
  skip: process.platform !== "darwin",
}, async () => {
  const fixture = await nativeFixture();
  try {
    const transport = await createTransport({ ...options, cliPath: fixture.executable });
    const prepared = transport.prepare("version", ["echo"], "public");
    const stdout = await prepared.execute(async (p) => {
      assert.deepEqual(p, prepared.proposal);
      await assert.rejects(access(p.parameters.cwd));
      return lease(p);
    });
    assert.equal(stdout.toString(), "public");
    await assert.rejects(access(prepared.proposal.parameters.cwd));
    await assert.rejects(prepared.execute(async (p) => lease(p)), { code: "authorization" });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("actual CLI cwd is empty, separate from copied binary, home and output schema", { skip: process.platform !== "darwin" }, async () => {
  const fixture = await nativeFixture();
  try {
    const transport = await createTransport({ ...options, cliPath: fixture.executable });
    const prepared = transport.prepare("version", ["empty"]);
    assert.equal((await prepared.execute(async (p) => lease(p))).toString().trim(), "empty");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("inactive and failed integrity hooks refuse before each call", { skip: process.platform !== "darwin" }, async () => {
  const inactive = await createTransport({ ...options, isActive: undefined });
  await assert.rejects(inactive.check(true), { code: "inactive" });
  let good = true;
  const transport = await createTransport({ ...options, checkIntegrity: () => good });
  await transport.check(true);
  good = false;
  await assert.rejects(transport.check(true), { code: "integrity" });
  const prepared = transport.prepare("version", ["--version"]);
  await assert.rejects(prepared.execute(async (p) => lease(p)), { code: "integrity" });
  await assert.rejects(access(prepared.proposal.parameters.cwd));
});

test("unsafe configuration and unbounded input fail without process startup", async () => {
  for (const patch of [{ endpointHost: "localhost" }, { egressHosts: [] },
    { egressHosts: ["other.example.com"] }, { cliPath: "trae-cli" }, { limits: { timeoutMs: 0 } }]) {
    await assert.rejects(createTransport({ ...options, ...patch }));
  }
  if (process.platform !== "darwin") return;
  const transport = await createTransport({ ...options, limits: { maxInputBytes: 16 } });
  assert.throws(() => transport.prepare("generate", ["--version"], "x".repeat(17)), { code: "input_limit" });
});

test("replaced executable bytes refuse before authorization and leave no setup", { skip: process.platform !== "darwin" }, async () => {
  const fixture = await nativeFixture();
  let authorized = false;
  try {
    const transport = await createTransport({ ...options, cliPath: fixture.executable });
    const prepared = transport.prepare("version", ["--version"]);
    await appendFile(fixture.executable, "synthetic integrity change");
    await assert.rejects(prepared.execute(async (p) => { authorized = true; return lease(p); }), { code: "integrity" });
    assert.equal(authorized, false);
    await assert.rejects(access(prepared.proposal.parameters.temporaryRoot));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("generation binds and writes the host-provided action schema unchanged", { skip: process.platform !== "darwin" }, async () => {
  const { modelActionEnvelopeSchema } = await import("../../models/src/prompt.ts");
  const { parametersHash } = await import("../src/transport.ts");
  const outputSchema = modelActionEnvelopeSchema.toJsonSchema();
  const transport = await createTransport({ ...options, outputSchema } as any);
  const script = "const fs=require('node:fs'); const at=process.argv.indexOf('--output-schema'); " +
    "const schema=JSON.parse(fs.readFileSync(process.argv[at+1],'utf8')); console.log(JSON.stringify(schema));";
  const prepared = transport.prepare("generate", ["--jitless", "-e", script, "--"]);
  assert.equal((prepared.proposal.parameters as any).outputSchemaHash, parametersHash(outputSchema));
  const bytes = await prepared.execute(async proposal => lease(proposal));
  assert.deepEqual(JSON.parse(bytes.toString()), outputSchema);
});

test("absolute setup lifetime stops a pending integrity check before authorization", { skip: process.platform !== "darwin" }, async () => {
  let release!: () => void;
  const pending = new Promise<boolean>(resolve => { release = () => resolve(true); });
  const transport = await createTransport({ ...options, limits: { timeoutMs: 20 }, checkIntegrity: () => pending });
  let authorized = false;
  const keepAlive = setInterval(() => {}, 50);
  const eventual = setTimeout(() => release(), 100);
  try {
    await assert.rejects(executeTransport(transport, "models", ["models", "--json"], "", async proposal => {
      authorized = true; return lease(proposal);
    }), { code: "timeout" });
    assert.equal(authorized, false);
  } finally { release(); clearInterval(keepAlive); clearTimeout(eventual); }
});

test("cancelled authorization does not await or accept its late lease", { skip: process.platform !== "darwin" }, async () => {
  const fixture = await nativeFixture();
  try {
    const transport = await createTransport({ ...options, cliPath: fixture.executable });
    const prepared = transport.prepare("version", ["--version"]);
    const controller = new AbortController();
    let release!: () => void;
    const late = new Promise<ReturnType<typeof lease>>(resolve => { release = () => resolve(lease(prepared.proposal)); });
    const eventual = setTimeout(() => release(), 100);
    const call = prepared.execute(() => { controller.abort(); return late; }, controller.signal);
    try { await assert.rejects(call, { code: "cancelled" }); }
    finally { release(); clearTimeout(eventual); }
    await assert.rejects(access(prepared.proposal.parameters.cwd));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
