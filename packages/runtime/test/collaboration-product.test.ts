import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { KernelSession, putArtifact, readLedger, resolveKeystonePaths } from "@keystone/kernel";
import { canonicalJson, contentHash, newId, projectFactSchema, provenanceRefSchema, sha256Hex } from "@keystone/schemas";
import * as collaboration from "../src/collaboration/index.ts";
import { makeFixture, removeFixture } from "./fixture.ts";

const ui = { authenticated: true, source: "local_ui" } as const;
async function setup() {
  assert.equal(typeof (collaboration as any).createLocalCollaboration, "function",
    "product collaboration factory must exist");
  const fixture = await makeFixture();
  const projectId = newId("proj");
  const projects = [{ projectId, workspaceId: projectId, rootPath: fixture.root, name: "Fixture", status: "available", tasks: [] as string[] }];
  let paths = fixture.paths;
  const local = (collaboration as any).createLocalCollaboration({ paths: () => paths, projects: async () => projects });
  const call = (path: string, body?: unknown, context: unknown = ui) =>
    local.service.handle(body === undefined ? "GET" : "POST", `/v1/collaboration${path}`, body, context);
  const source = await KernelSession.create({ paths, projectId: projectId as never, request: "local task" });
  const artifact = await putArtifact(paths, "public observation\n");
  await source.recordExecution({ proposalId: newId("prop"), status: "succeeded", durationMs: 1,
    artifactId: artifact.artifactId, changedPaths: [] });
  projects[0]!.tasks.push(source.taskId);
  return { ...fixture, local, call, source, projectId, projects, artifact,
    relocate: (home: string) => { paths = resolveKeystonePaths(home); } };
}

test("product factory is public-only, denies fabricated consent and pins/revokes public peers", async () => {
  const f = await setup();
  try {
    const initial = await f.call("");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.identity.algorithm, "Ed25519");
    assert.equal(initial.body.identity.retention, "session_only");
    assert.equal(initial.body.identity.trustLevel, "untrusted");
    assert.doesNotMatch(canonicalJson(initial.body), /PRIVATE KEY/);
    const keys = generateKeyPairSync("ed25519");
    const body = { projectId: f.projectId, identityId: "bob",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      endpoint: "http://127.0.0.1:1234/delegate", confirmed: true };
    assert.equal((await f.call("/peers/register", body, null)).status, 403);
    assert.equal((await f.call("/peers/register", { ...body, confirmed: false, decisionId: "forged" })).status, 400);
    assert.equal((await f.call("/peers/register", { ...body, decisionId: "forged" })).status, 400);
    const admitted = await f.call("/peers/register", body);
    assert.equal(admitted.status, 200);
    const audit = await readLedger(f.paths.ledgerFile(admitted.body.taskId));
    assert.equal(audit.integrity.ok, true);
    assert.ok(audit.events.some((e) => e.type === "intervention.decided" && e.payload["recordedBy"] === "user"));
    assert.ok(audit.events.some((e) => e.type === "lease.issued" && e.payload["capability"] === "fs.write"));
    const status = (await f.call("")).body;
    assert.equal(status.peers[0].trustLevel, "untrusted");
    assert.equal((await f.call("/peers/revoke", { projectId: f.projectId, identityId: "bob", confirmed: true })).status, 200);
    assert.equal((await f.call("")).body.peers[0].revoked, true);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    assert.equal((await f.call("/peers/register", { ...body, identityId: "rsa", publicKey: rsa })).status, 400);
    assert.equal((await f.call("/peers/register", { ...body, identityId: "bad", endpoint: "https://user:pass@example.com/" })).status, 400);
    const publicRegistry = await readFile(join(f.home, "collaboration", "peers.json"), "utf8");
    assert.doesNotMatch(publicRegistry, /PRIVATE KEY|privateKey/);
  } finally { await f.local.dispose(); await removeFixture(f); }
});

test("export -> preview -> quarantined import -> fresh draft never adopts foreign completion", async () => {
  const f = await setup();
  try {
    const original = await readFile(f.paths.ledgerFile(f.source.taskId), "utf8");
    const exportBody = { projectId: f.projectId, taskId: f.source.taskId, confirmed: true };
    assert.equal((await f.call("/export", { ...exportBody, confirmed: false })).status, 400);
    const exported = await f.call("/export", exportBody);
    assert.equal(exported.status, 200, canonicalJson(exported.body));
    const preview = await f.call("/preview", { root: exported.body.root });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.artifacts.length, 1);
    assert.equal(preview.body.artifacts[0].artifactId, f.artifact.artifactId);
    assert.equal(preview.body.authority, "imported_candidate");
    const input = { projectId: f.projectId, root: exported.body.root, digest: preview.body.digest, confirmed: true };
    assert.equal((await f.call("/import", { ...input, digest: sha256Hex("tampered") })).status, 400);
    assert.equal((await f.call("/import", { ...input, destination: f.paths.tasksDir })).status, 400);
    const imported = await f.call("/import", input);
    assert.equal(imported.status, 200);
    assert.ok(imported.body.destination.startsWith(join(f.home, "collaboration", "quarantine")));
    const quarantined = await collaboration.previewBundle(imported.body.destination);
    assert.equal(quarantined.digest, preview.body.digest);
    assert.equal(await readFile(f.paths.ledgerFile(f.source.taskId), "utf8"), original);
    const adopted = await f.call("/adopt-task", { projectId: f.projectId, importId: imported.body.importId,
      digest: preview.body.digest, request: "Independently review imported work", confirmed: true });
    assert.equal(adopted.status, 200);
    assert.notEqual(adopted.body.taskId, f.source.taskId);
    const draft = await KernelSession.open({ paths: f.paths, taskId: adopted.body.taskId });
    assert.equal(draft.state().status, "draft");
    assert.equal(draft.events().length, 2);
    assert.equal(draft.events().some((e) => e.type === "evidence.recorded" || e.type.startsWith("proof.") || e.type === "lease.issued"), false);
    assert.match(canonicalJson(draft.events()), /untrusted|imported_candidate/);
    assert.equal((await f.call("/adopt-task", { projectId: f.projectId, importId: imported.body.importId,
      digest: preview.body.digest, request: "repeat", confirmed: true })).status, 400);
    const manifest = JSON.parse(await readFile(join(exported.body.root, "manifest.json"), "utf8"));
    await writeFile(join(exported.body.root, manifest.artifacts[0].path), "tampered");
    assert.equal((await f.call("/preview", { root: exported.body.root })).status, 400);
  } finally { await f.local.dispose(); await removeFixture(f); }
});

test("dynamic roots, symlink escapes, credential text and implicit workspace capsules fail closed", async () => {
  const f = await setup();
  try {
    const request = { projectId: f.projectId, taskId: f.source.taskId, confirmed: true };
    await mkdir(join(f.home, "collaboration"), { recursive: true });
    await symlink(f.root, join(f.home, "collaboration", "exports"));
    assert.equal((await f.call("/export", request)).status, 400);
    assert.deepEqual((await readdir(f.root)).sort(), [".git", "package-lock.json", "package.json", "src", "test"]);
    f.relocate(join(f.home, "relocated"));
    const status = (await f.call("")).body;
    assert.equal(status.roots.exports, join(f.home, "relocated", "collaboration", "exports"));
    assert.equal((await f.call("/preview", { root: f.root })).status, 400);
    f.relocate(f.home);
    // Source refusal happens before any destination write.
    const capsule = await putArtifact(f.paths, canonicalJson({ version: "keystone.workspace-recovery/1", patch: "private workspace" }));
    await f.source.recordExecution({ proposalId: newId("prop"), status: "succeeded", durationMs: 0,
      artifactId: capsule.artifactId, changedPaths: [] });
    const blocked = await f.call("/export", request);
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.reason, /capsule/i);
    const secretTask = await KernelSession.create({ paths: f.paths, projectId: f.projectId as never, request: "public" });
    const secret = await putArtifact(f.paths, "API_KEY=example-not-a-real-secret");
    await secretTask.recordExecution({ proposalId: newId("prop"), status: "succeeded", durationMs: 0,
      artifactId: secret.artifactId, changedPaths: [] });
    const denied = await f.call("/export", { ...request, taskId: secretTask.taskId });
    assert.equal(denied.status, 400);
    assert.match(denied.body.reason, /secret/i);
  } finally { await f.local.dispose(); await removeFixture(f); }
});

test("shared candidates retain upstream provenance and report unsupported promotion honestly", async () => {
  const f = await setup();
  try {
    const source = provenanceRefSchema.parse({ provenanceId: newId("prov"), sourceKind: "repository",
      trustLevel: "verified", locator: "upstream/rules", derivedFrom: [], invalidatedBy: [],
      observedAt: new Date().toISOString() });
    const input = { kind: "experience", key: "refresh", statement: "Refresh once", source,
      sourceIdentity: "bob", sourceDigest: sha256Hex("rule") };
    const result = await f.call("/share", { projectId: f.projectId, input, confirmed: true });
    assert.equal(result.status, 200);
    assert.equal(result.body.trustLevel, "untrusted");
    assert.deepEqual(result.body.source, source);
    const adoption = await f.call("/adopt", { candidateId: result.body.candidateId, digest: contentHash(result.body), confirmed: true });
    assert.equal(adoption.status, 501);
    assert.match(adoption.body.reason, /trust|promotion/i);
  } finally { await f.local.dispose(); await removeFixture(f); }
});

test("explicit initialization creates bounded roots and local sharing reuses actual source provenance", async () => {
  const f = await setup();
  try {
    const before = await readdir(f.home);
    assert.equal(before.includes("collaboration"), false);
    assert.equal((await f.call("/initialize", { projectId: f.projectId, confirmed: false })).status, 400);
    const initialized = await f.call("/initialize", { projectId: f.projectId, confirmed: true });
    assert.equal(initialized.status, 200);
    assert.deepEqual((await readdir(join(f.home, "collaboration"))).sort(), ["exports", "inbox", "quarantine"]);
    const audit = await readLedger(f.paths.ledgerFile(initialized.body.taskId));
    assert.ok(audit.events.some((event) => event.type === "lease.issued" && event.payload["capability"] === "fs.write"));
    const source = provenanceRefSchema.parse({ provenanceId: newId("prov"), sourceKind: "repository",
      trustLevel: "untrusted", locator: "AGENTS.md", derivedFrom: [], invalidatedBy: [], observedAt: new Date().toISOString() });
    const fact = projectFactSchema.parse({ factId: newId("fact"), projectId: f.projectId, kind: "rule", statement: "Keep relative imports explicit",
      source, derivedFrom: [], invalidatedBy: [], status: "active", observedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), subjects: ["src/**"] });
    await KernelSession.updateProjectFacts({ paths: f.paths, projectId: f.projectId, facts: [fact], reason: "fixture source" });
    const sources = await f.call(`/sources/${f.projectId}`);
    assert.equal(sources.status, 200);
    assert.deepEqual(sources.body.sources[0].source, source);
    const body = { projectId: f.projectId, sourceId: fact.factId, sourceDigest: sources.body.sources[0].sourceDigest, confirmed: true };
    assert.equal((await f.call("/share", { ...body, sourceDigest: sha256Hex("stale") })).status, 400);
    const shared = await f.call("/share", body);
    assert.equal(shared.status, 200);
    assert.deepEqual(shared.body.source, source);
    assert.equal(shared.body.sourceIdentity, f.local.identity().identityId);
    assert.equal(shared.body.trustLevel, "untrusted");
  } finally { await f.local.dispose(); await removeFixture(f); }
});

test("delegation prepares without IO, requires opt-in, commits observation without proof and aborts a fixture", async () => {
  const f = await setup();
  const keys = generateKeyPairSync("ed25519");
  let hits = 0;
  let slow = false;
  let receiver: collaboration.DelegationReceiver;
  const server = createServer(async (req, res) => {
    hits++;
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const response = await receiver.receive(JSON.parse(Buffer.concat(parts).toString("utf8")));
    res.end(canonicalJson(response));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/delegate`;
  try {
    await f.call("/peers/register", { projectId: f.projectId, identityId: "bob",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), endpoint, confirmed: true });
    const identity = (await f.call("")).body.identity;
    receiver = new collaboration.DelegationReceiver({ identityId: "bob", endpoint,
      peers: () => [{ ...identity, revoked: false }], scopePaths: ["src/auth/session.js"],
      maxBudget: { maxTokens: 10, maxBytes: 16384, maxWallClockMs: 5000 },
      admit: async (_request, signal) => {
        if (slow) await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
        return { observation: { level: "E0", childClaimsCompleted: true }, usage: { tokens: 0 } };
      }, sign: (doc, binding) => collaboration.signDocument(doc, binding, "bob", keys.privateKey) });
    const body = { projectId: f.projectId, recipientId: "bob", scopePaths: ["src/auth/session.js"],
      budget: { maxTokens: 10, maxBytes: 16384, maxWallClockMs: 5000 }, parameters: { instruction: "Observe only" }, confirmed: true };
    const prepared = await f.call("/delegation/prepare", body);
    assert.equal(prepared.status, 200);
    assert.equal(hits, 0);
    assert.notEqual(prepared.body.taskId, f.source.taskId);
    assert.equal((await f.call("/delegate", { delegationId: prepared.body.delegationId, confirmed: false })).status, 400);
    assert.equal(hits, 0);
    const result = await f.call("/delegate", { delegationId: prepared.body.delegationId,
      digest: prepared.body.digest, confirmed: true });
    assert.equal(result.status, 200);
    assert.equal(result.body.observation.trustLevel, "untrusted");
    const audit = await readLedger(f.paths.ledgerFile(prepared.body.taskId));
    assert.ok(audit.events.some((e) => e.type === "action.executed" && e.payload["outputArtifactId"]));
    assert.equal(audit.events.some((e) => e.type === "evidence.recorded" || e.type.startsWith("proof.")), false);
    assert.equal((await KernelSession.open({ paths: f.paths, taskId: prepared.body.taskId })).state().status, "stopped");
    slow = true;
    const next = await f.call("/delegation/prepare", body);
    const send = { delegationId: next.body.delegationId, digest: next.body.digest, confirmed: true };
    const pending = f.call("/delegate", send);
    const duplicate = f.call("/delegate", send);
    assert.equal(await Promise.race([duplicate.then(() => true),
      new Promise((done) => setTimeout(() => done(false), 300))]), true, "duplicate admission must reject without waiting for transport");
    assert.equal((await duplicate).status, 400);
    while (hits < 2) await new Promise((done) => setTimeout(done, 2));
    const stopped = await f.call("/delegation/stop", { delegationId: next.body.delegationId, confirmed: true });
    assert.equal(stopped.status, 200);
    assert.equal((await pending).status, 400);
    const stoppedAudit = await readLedger(f.paths.ledgerFile(next.body.taskId));
    assert.equal(stoppedAudit.events.some((e) => e.type === "action.executed" && e.payload["outputArtifactId"]), false);
    const withdrawn = await f.call("/delegation/prepare", body);
    const withdrawnSend = f.call("/delegate", { delegationId: withdrawn.body.delegationId, digest: withdrawn.body.digest, confirmed: true });
    while (hits < 3) await new Promise((done) => setTimeout(done, 2));
    await writeFile(join(f.home, "collaboration", "peers.json"), "[]");
    const refreshed = await f.call("");
    assert.equal(refreshed.body.delegations.find((d: any) => d.delegationId === withdrawn.body.delegationId).status, "stopped");
    assert.equal((await withdrawnSend).status, 400);
  } finally {
    await f.local.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await removeFixture(f);
  }
});

const settleUi = () => new Promise<void>((done) => setImmediate(done));
async function untilUi(predicate: () => boolean) {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((done) => setTimeout(done, 5));
  assert.ok(predicate(), "UI action did not settle");
}
function productDom() {
  const document: any = { activeElement: null };
  const walk = (root: any): any[] => root.children.flatMap((child: any) =>
    typeof child === "object" ? [child, ...walk(child)] : []);
  const create = (tag = "div"): any => ({
    tagName: tag.toUpperCase(), children: [] as any[], attributes: {} as Record<string, string>,
    value: "", disabled: false, handlers: {} as Record<string, ((event: any) => unknown)[]>,
    setAttribute(key: string, value: string) { this.attributes[key] = value; if (key === "id") this.id = value; },
    append(...children: any[]) { this.children.push(...children); },
    replaceChildren(...children: any[]) { this.children = children; this._text = undefined; },
    addEventListener(kind: string, fn: any) { (this.handlers[kind] ??= []).push(fn); },
    async dispatch(kind: string) {
      for (const handler of this.handlers[kind] ?? []) await handler({ target: this, currentTarget: this });
      await settleUi();
    },
    click() { return this.disabled ? Promise.resolve() : this.dispatch("click"); },
    focus() { document.activeElement = this; },
    get textContent() { return this._text ?? this.children.map((child: any) => child.textContent ?? child).join("\n"); },
    set textContent(value: string) { this._text = value; },
  });
  document.createElement = create; document.getElementById = () => null;
  const host = create();
  return {
    document, host,
    button(label: string) {
      const found = walk(host).find((value) => value.tagName === "BUTTON" && value.textContent === label);
      assert.ok(found, `Missing action: ${label}`); return found;
    },
    async enter(id: string, value: string, event = "input") {
      const found = walk(host).find((entry) => entry.id === id);
      assert.ok(found, `Missing field: ${id}`); found.value = value; await found.dispatch(event);
    },
  };
}
async function withProductDom(work: (fixture: ReturnType<typeof productDom>) => Promise<void>) {
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; const fixture = productDom(); globals.document = fixture.document;
  try { await work(fixture); } finally { globals.document = original; }
}
const productView = async () => (await import(new URL("../web/views/collaboration.js", import.meta.url).href)).createCollaborationView;

test("public UI JSON refuses credential-shaped strings before local requests", async () => {
  const { parsePublicJson } = await import(new URL("../web/state/collaboration.js", import.meta.url).href);
  assert.throws(() => parsePublicJson('{"description":"API_KEY=example-not-a-real-secret"}'), /secret/i);
  assert.throws(() => parsePublicJson('{"url":"https://user:example@example.com/"}'), /secret/i);
  assert.deepEqual(parsePublicJson('{"instruction":"Observe public output"}'), { instruction: "Observe public output" });
});

test("collaboration UI performs confirmed pin/export/preview/quarantine/fresh-draft workflows", async () => {
  const f = await setup();
  try {
    const at = new Date().toISOString();
    const fact = projectFactSchema.parse({ factId: newId("fact"), projectId: f.projectId, kind: "rule",
      statement: "Keep public content local", source: provenanceRefSchema.parse({ provenanceId: newId("prov"),
        sourceKind: "repository", trustLevel: "untrusted", locator: "AGENTS.md", derivedFrom: [], invalidatedBy: [], observedAt: at }),
      derivedFrom: [], invalidatedBy: [], status: "active", observedAt: at, updatedAt: at, subjects: ["src/**"] });
    await KernelSession.updateProjectFacts({ paths: f.paths, projectId: f.projectId, facts: [fact], reason: "UI fixture source" });
    await withProductDom(async (dom) => {
      let confirmed = false;
      let adoptedTask: { taskId: string; projectId: string; request: string } | undefined;
      const calls: { path: string; input: any }[] = [];
      const view = (await productView())(dom.host, {
        dialogs: { confirm: async () => confirmed },
        afterAdopt: async (result: { taskId: string }, context: { projectId: string; request: string }) => {
          adoptedTask = { taskId: result.taskId, ...context };
        },
        request: async (path: string, init: any = {}) => {
          const input = init.body ? JSON.parse(init.body) : undefined; calls.push({ path, input });
          const result = await f.local.service.handle(init.method ?? "GET", path, input, ui);
          if (result.status >= 400) throw Object.assign(new Error(result.body.error), { status: result.status, body: result.body });
          return result.body;
        },
      });
      await untilUi(() => !view.resource.state.loading);
      assert.match(dom.host.textContent, /Ed25519|session_only/);
      const keys = generateKeyPairSync("ed25519");
      await dom.enter("collaboration-peer-id", "bob");
      await dom.enter("collaboration-peer-key", keys.publicKey.export({ type: "spki", format: "pem" }).toString());
      await dom.button("Pin public peer").click(); await settleUi();
      assert.equal(calls.some((c) => c.path.endsWith("/peers/register")), false);
      confirmed = true;
      await dom.button("Pin public peer").click();
      await untilUi(() => view.resource.state.data.peers?.length === 1 && !view.resource.state.busy);
      assert.equal(calls.find((c) => c.path.endsWith("/peers/register"))!.input.confirmed, true);
      await untilUi(() => !dom.button("Preview shared candidate").disabled);
      await dom.button("Preview shared candidate").click();
      await untilUi(() => view.resource.state.data.candidates?.length === 1 && !view.resource.state.busy);
      assert.deepEqual(calls.find((c) => c.path.endsWith("/share"))!.input,
        { projectId: f.projectId, sourceId: fact.factId, sourceDigest: contentHash(fact), confirmed: true });
      assert.deepEqual(view.resource.state.data.candidates[0].source, fact.source);
      assert.equal(view.resource.state.data.candidates[0].trustLevel, "untrusted");
      await dom.enter("collaboration-task-id", f.source.taskId);
      await dom.button("Export local task").click();
      await untilUi(() => !!view.resource.state.result?.root && !view.resource.state.busy);
      await dom.button("Preview portable package").click();
      await untilUi(() => !!view.resource.state.result?.artifacts && !view.resource.state.busy);
      await settleUi();
      assert.equal(dom.button("Import reviewed package").disabled, false);
      await dom.button("Import reviewed package").click();
      await untilUi(() => view.resource.state.data.imports?.length === 1 && !view.resource.state.busy);
      const imported = calls.find((c) => c.path.endsWith("/import"))!.input;
      assert.ok(imported.digest); assert.equal(imported.destination, undefined); assert.equal(imported.decisionId, undefined);
      await dom.enter("collaboration-adopt-request", "Review imported changes independently");
      await dom.button("Create fresh local draft").click();
      await untilUi(() => !!view.resource.state.data.imports[0].adoptedTaskId && !view.resource.state.busy);
      const draft = await KernelSession.open({ paths: f.paths, taskId: view.resource.state.data.imports[0].adoptedTaskId });
      assert.equal(draft.state().status, "draft");
      assert.deepEqual(adoptedTask, {
        taskId: draft.taskId,
        projectId: f.projectId,
        request: "Review imported changes independently",
      });
      await dom.button("Revoke peer").click();
      await untilUi(() => view.resource.state.data.peers[0].revoked && !view.resource.state.busy);
      view.dispose();
    });
  } finally { await f.local.dispose(); await removeFixture(f); }
});

test("collaboration UI invalidates preview edits and displays service reasons without promoting candidates", async () => {
  await withProductDom(async (dom) => {
    const calls: string[] = [];
    let refuse = false;
    const view = (await productView())(dom.host, {
      dialogs: { confirm: async () => true },
      request: async (path: string, init: any = {}) => {
        calls.push(path);
        if (refuse && init.method) throw Object.assign(new Error("collaboration_request_rejected"),
          { status: 400, body: { reason: "Reviewed bundle digest changed" } });
        if (path.endsWith("/preview")) return { digest: "digest", root: "/exports/one", artifacts: [], authority: "imported_candidate" };
        return { projects: [{ projectId: "p", name: "Project", status: "available" }], importAvailable: true,
          adoptionAvailable: false, taskAdoptionAvailable: true, peers: [], imports: [], candidates: [] };
      },
    });
    await untilUi(() => !view.resource.state.loading);
    await dom.enter("collaboration-root", "/exports/one");
    await dom.button("Preview portable package").click();
    await untilUi(() => !!view.resource.state.result?.digest && !view.resource.state.busy);
    await settleUi();
    assert.equal(dom.button("Import reviewed package").disabled, false);
    await dom.enter("collaboration-root", "/exports/two");
    assert.equal(dom.button("Import reviewed package").disabled, true);
    await dom.button("Import reviewed package").click();
    assert.equal(calls.some((path) => path.endsWith("/import")), false);
    refuse = true;
    await dom.button("Preview portable package").click();
    await untilUi(() => !!view.resource.state.error && !view.resource.state.busy);
    await settleUi();
    assert.match(dom.host.textContent, /Reviewed bundle digest changed/);
    assert.match(dom.host.textContent, /untrusted|promotion/i);
    view.dispose();
  });
});

test("collaboration UI sends only after separate opt-in and Stop is usable during pending transport", async () => {
  await withProductDom(async (dom) => {
    let release!: (value: any) => void;
    let allow = false; let sends = 0; let stops = 0;
    const data: any = { projects: [{ projectId: "p", name: "Project", status: "available" }],
      peers: [{ identityId: "bob", endpoint: "http://127.0.0.1:1234/delegate", revoked: false }],
      delegation: { outboundAvailable: true }, delegations: [], imports: [], adoptionAvailable: false };
    const view = (await productView())(dom.host, {
      dialogs: { confirm: async () => allow },
      request: async (path: string, init: any = {}) => {
        if (path.endsWith("/delegation/prepare")) {
          data.delegations = [{ delegationId: "d", digest: "digest", status: "prepared", endpoint: data.peers[0].endpoint }];
          return { delegationId: "d", digest: "digest", signed: { document: {} }, networkAttempted: false };
        }
        if (path.endsWith("/delegate")) {
          sends++; data.delegations[0].status = "sending";
          return new Promise((done) => { release = done; });
        }
        if (path.endsWith("/delegation/stop")) {
          stops++; assert.deepEqual(JSON.parse(init.body), { delegationId: "d", confirmed: true });
          data.delegations[0].status = "stopped"; release({ delegationId: "d", status: "stopped" });
          return { delegationId: "d", status: "stopped" };
        }
        return structuredClone(data);
      },
    });
    await untilUi(() => !view.resource.state.loading);
    await dom.enter("collaboration-recipient", "bob", "change");
    await dom.enter("collaboration-scope", "src/auth.ts");
    await dom.enter("collaboration-instruction", "Observe");
    await dom.enter("collaboration-max-tokens", "10");
    await dom.enter("collaboration-max-bytes", "16384");
    await dom.enter("collaboration-max-ms", "5000");
    allow = true;
    await dom.button("Prepare bounded delegation").click();
    await untilUi(() => view.resource.state.data.delegations.length === 1 && !view.resource.state.busy);
    assert.equal(sends, 0);
    allow = false;
    await dom.button("Send prepared delegation").click(); await settleUi();
    assert.equal(sends, 0);
    allow = true;
    await dom.button("Send prepared delegation").click();
    await untilUi(() => sends === 1);
    assert.equal(dom.button("Stop delegation").disabled, false);
    await dom.button("Stop delegation").click();
    await untilUi(() => stops === 1 && !view.resource.state.busy);
    view.dispose();
  });
});
