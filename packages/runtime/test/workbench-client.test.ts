import assert from "node:assert/strict";
import test from "node:test";

async function moduleAt(path: string): Promise<any> {
  return import(new URL(`../web/${path}`, import.meta.url).href).catch(() => ({}));
}

function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function transport() {
  const pending: { path: string; init: any; response: ReturnType<typeof deferred> }[] = [];
  const request = (path: string, init: any = {}) => {
    const response = deferred();
    pending.push({ path, init, response });
    return response.promise;
  };
  return { pending, request };
}

function bundle(entries: ReturnType<typeof transport>["pending"], taskId: string, marker: string) {
  for (const entry of entries) {
    const suffix = entry.path.split(`/v1/tasks/${taskId}`)[1];
    if (suffix === "") entry.response.resolve({ taskId, projectId: "proj_one", status: "executing", marker });
    else if (suffix === "/proof") entry.response.resolve({ taskId, outcome: "unproven", marker });
    else if (suffix?.startsWith("/events")) entry.response.resolve({ events: [{ seq: 1, type: marker }], integrity: { ok: true } });
    else if (suffix === "/checkpoints") entry.response.resolve({ checkpoints: [{ checkpointId: marker }] });
    else if (suffix === "/run") entry.response.resolve({ taskId, status: "running", marker });
  }
}

test("rapid reordered task selection commits only the selected bundle", async () => {
  const { createWorkbenchClient } = await moduleAt("state/workbench.js");
  assert.equal(typeof createWorkbenchClient, "function", "the browser must export its actual selection client");
  const wire = transport();
  const client = createWorkbenchClient({ request: wire.request });
  const snapshots: any[] = [];
  client.subscribe((state: any) => snapshots.push({ ...state }));
  const old = client.selectTask("task_A");
  const previous = wire.pending.slice();
  const current = client.selectTask("task_B");
  assert.ok(previous.every((entry) => entry.init.signal.aborted));
  bundle(wire.pending.slice(previous.length), "task_B", "new");
  await current;
  bundle(previous, "task_A", "old");
  await old;
  assert.equal(client.state.taskId, "task_B");
  assert.equal(client.state.detail.marker, "new");
  assert.equal(client.state.proof.marker, "new");
  assert.equal(client.state.run.marker, "new");
  assert.equal(client.state.events[0].type, "new");
  assert.equal(client.state.checkpoints[0].checkpointId, "new");
  assert.ok(snapshots.every((state) => state.detail === null || state.detail.taskId === state.taskId));
});

test("same-task reselection uses versions, not just task identity", async () => {
  const { createWorkbenchClient } = await moduleAt("state/workbench.js");
  assert.equal(typeof createWorkbenchClient, "function");
  const wire = transport();
  const client = createWorkbenchClient({ request: wire.request });
  const first = client.selectTask("task_A");
  const oldEntries = wire.pending.slice();
  const second = client.selectTask("task_A");
  bundle(wire.pending.slice(oldEntries.length), "task_A", "second");
  await second;
  bundle(oldEntries, "task_A", "first");
  await first;
  assert.equal(client.state.detail.marker, "second");
});

test("a failed proof refresh keeps the entire known bundle visibly stale", async () => {
  const { createWorkbenchClient } = await moduleAt("state/workbench.js");
  assert.equal(typeof createWorkbenchClient, "function");
  const wire = transport();
  const client = createWorkbenchClient({ request: wire.request });
  const selected = client.selectTask("task_A");
  bundle(wire.pending, "task_A", "known");
  await selected;
  const offset = wire.pending.length;
  const polled = client.poll();
  const entries = wire.pending.slice(offset);
  const proof = entries.find((entry) => entry.path.endsWith("/proof"))!;
  proof.response.reject(new Error("offline"));
  bundle(entries.filter((entry) => entry !== proof), "task_A", "partial");
  await polled;
  assert.equal(client.state.detail.marker, "known");
  assert.equal(client.state.proof.marker, "known");
  assert.equal(client.state.connection, "stale");
  assert.match(client.state.error, /offline/);
});

test("hiding aborts a refresh and reconnect reloads the same task atomically", async () => {
  const { createWorkbenchClient } = await moduleAt("state/workbench.js");
  assert.equal(typeof createWorkbenchClient, "function");
  const wire = transport();
  const client = createWorkbenchClient({ request: wire.request });
  const first = client.selectTask("task_A");
  bundle(wire.pending, "task_A", "known");
  await first;
  const offset = wire.pending.length;
  const poll = client.poll();
  client.setVisible(false);
  assert.ok(wire.pending.slice(offset).every((entry) => entry.init.signal.aborted));
  bundle(wire.pending.slice(offset), "task_A", "hidden");
  await poll;
  assert.equal(client.state.detail.marker, "known");
  const before = wire.pending.length;
  client.setVisible(true);
  const reconnected = client.reconnect();
  bundle(wire.pending.slice(before), "task_A", "reconnected");
  await reconnected;
  assert.equal(client.state.detail.marker, "reconnected");
  assert.equal(client.state.connection, "connected");
  client.dispose();
});

test("drafts are isolated by project and task, including attachment references", async () => {
  const { createDraftStore } = await moduleAt("state/drafts.js");
  assert.equal(typeof createDraftStore, "function");
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) };
  const drafts = createDraftStore(storage);
  drafts.set("proj_A", null, { request: "new A", attachmentIds: ["att_A"] });
  drafts.set("proj_A", "task_A", { request: "revision" });
  drafts.set("proj_B", null, { request: "new B" });
  const restored = createDraftStore(storage);
  assert.equal(restored.get("proj_A", null).request, "new A");
  assert.deepEqual(restored.get("proj_A", null).attachmentIds, ["att_A"]);
  assert.equal(restored.get("proj_A", "task_A").request, "revision");
  assert.equal(restored.get("proj_B", null).request, "new B");
  assert.equal(restored.get("proj_C", null).request, "");
});

test("file conflicts preserve edits and hash; explicit reload is required", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  assert.equal(typeof createFileClient, "function");
  const calls: any[] = [];
  const request = async (path: string, init: any = {}) => {
    calls.push({ path, init });
    if (init.method === "POST") throw Object.assign(new Error("file changed"), { status: 409, body: { currentHash: "other" } });
    return { path: "src/a.ts", content: "original", hash: "original-hash", binary: false, truncated: false };
  };
  const client = createFileClient({ request });
  client.setProject("proj_A");
  await client.open("src/a.ts");
  client.edit("edited draft");
  await client.save();
  assert.equal(client.state.tabs[0].draft, "edited draft");
  assert.equal(client.state.tabs[0].hash, "original-hash");
  assert.equal(client.state.tabs[0].conflict.currentHash, "other");
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { operation: "write", path: "src/a.ts", content: "edited draft", expectedHash: "original-hash" });
});

test("late file reads never enter the newly selected project's tabs", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  assert.equal(typeof createFileClient, "function");
  const wire = transport();
  const client = createFileClient({ request: wire.request });
  client.setProject("proj_A");
  const old = client.open("a.ts");
  const entry = wire.pending[0]!;
  client.setProject("proj_B");
  assert.ok(entry.init.signal.aborted);
  entry.response.resolve({ path: "a.ts", content: "old", hash: "hash", binary: false, truncated: false });
  await old;
  assert.deepEqual(client.state.tabs, []);
});

test("attachment admission enforces count, supported types and byte limits", async () => {
  const { validateAttachment, imageRouteWarning, parseFileReferences } = await moduleAt("state/composer.js");
  assert.equal(typeof validateAttachment, "function");
  assert.equal(validateAttachment({ name: "screen.png", type: "image/png", size: 20 * 1024 * 1024 }, 9), null);
  assert.equal(validateAttachment({ name: "screen.png", type: "image/png", size: 1 }, 10), "Too many attachments (maximum 10).");
  assert.equal(validateAttachment({ name: "data.log", type: "", size: 10 * 1024 * 1024 + 1 }, 0), "Text exceeds 10 MiB.");
  assert.equal(validateAttachment({ name: "image.svg", type: "image/svg+xml", size: 1 }, 0), "Unsupported attachment type.");
  assert.ok(imageRouteWarning({ models: [{ id: "local", enabled: true, multimodal: false }] }, [{ kind: "image" }]));
  assert.equal(imageRouteWarning({ models: [{ id: "local", enabled: true, multimodal: true }] }, [{ kind: "image" }]), null);
  assert.deepEqual(parseFileReferences("Inspect @src/a.ts:4-9 and @docs/"), [{ kind: "file", value: "src/a.ts:4-9" }, { kind: "directory", value: "docs/" }]);
});

test("API client retains conflict bodies and never sends a token outside same origin", async () => {
  const { createApi } = await moduleAt("client/api.js");
  assert.equal(typeof createApi, "function");
  const calls: any[] = [];
  const api = createApi({
    token: "test-only",
    fetch: async (path: string, init: any) => {
      calls.push({ path, init });
      return new Response(JSON.stringify({ error: "conflict", currentHash: "new" }), { status: 409 });
    },
  });
  await assert.rejects(api("/v1/projects/proj_A/files", { method: "POST", body: "{}" }), (error: any) => error.status === 409 && error.body.currentHash === "new");
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer test-only");
  await assert.rejects(api("https://example.test/v1/tasks"));
  await assert.rejects(api("//example.test/v1/tasks"));
  assert.equal(calls.length, 1);
});

test("Diff line navigation follows hunk coordinates and preserves split replacements", async () => {
  const { parseDiff, splitDiff } = await moduleAt("components/diff.js");
  assert.equal(typeof parseDiff, "function");
  const parsed = parseDiff("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -4,2 +4,3 @@\n context\n-old\n+new\n+extra\n");
  const change = parsed.find((row: any) => row.kind === "addition");
  assert.equal(change.path, "src/a.ts");
  assert.equal(change.newLine, 5);
  const split = splitDiff(parsed);
  assert.ok(split.some((row: any) => row.left?.text === "old" && row.right?.text === "new"));
  assert.ok(split.some((row: any) => row.left === null && row.right?.text === "extra"));
});

test("cloud attachment consent names every routed destination and file before granting", async () => {
  const { confirmAttachmentEgress } = await moduleAt("state/composer.js");
  assert.equal(typeof confirmAttachmentEgress, "function");
  const config = { models: [
    { id: "local", kind: "local", enabled: true, endpointHost: "localhost:1234" },
    { id: "remote", kind: "cloud", enabled: true, endpointHost: "api.example.test", modelName: "vision" },
  ], routes: { builder: ["local", "remote"] } };
  const attachments = [{ attachmentId: "att_one", name: "screen.png", kind: "image", size: 120, contentHash: "sha256:test" }];
  let shown: any;
  assert.deepEqual(await confirmAttachmentEgress(config, attachments, async (plan: any) => {
    shown = plan; return true;
  }, () => true), { allowAttachmentEgress: true });
  assert.equal(shown.destinations[0].endpointHost, "api.example.test");
  assert.equal(shown.destinations[0].id, "remote");
  assert.equal(shown.files[0].name, "screen.png");
  assert.equal(shown.files[0].contentHash, "sha256:test");
  assert.equal(await confirmAttachmentEgress(config, attachments, async () => false, () => true), null);
  assert.equal(await confirmAttachmentEgress(config, attachments, async () => true, () => false), null);
});

test("local or attachment-free tasks never request or include a cloud attachment grant", async () => {
  const { confirmAttachmentEgress } = await moduleAt("state/composer.js");
  assert.equal(typeof confirmAttachmentEgress, "function");
  const confirm = () => { assert.fail("local content must not ask for a cloud grant"); };
  const local = { models: [{ id: "local", kind: "local", enabled: true }] };
  assert.deepEqual(await confirmAttachmentEgress(local, [{ name: "notes.md" }], confirm, () => true), {});
  assert.deepEqual(await confirmAttachmentEgress({ models: [{ id: "cloud", kind: "cloud", enabled: true }] }, [], confirm, () => true), {});
  assert.equal(await confirmAttachmentEgress(null, [{ name: "notes.md" }], confirm, () => true), null);
});

test("edits typed during the post-save hash read remain an unsaved draft", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const reload = deferred();
  let reads = 0;
  const client = createFileClient({ request: async (_path: string, init: any = {}) => {
    if (init.method === "POST") return { mutationId: "mut_one" };
    reads += 1;
    return reads === 1 ? { path: "a.ts", content: "old", hash: "old-hash" } : reload.promise;
  } });
  client.setProject("proj_one"); await client.open("a.ts"); client.edit("saved");
  const saving = client.save();
  await new Promise((resolve) => setImmediate(resolve));
  client.edit("still typing");
  reload.resolve({ path: "a.ts", content: "saved", hash: "saved-hash" });
  await saving;
  assert.equal(client.current().hash, "saved-hash");
  assert.equal(client.current().draft, "still typing");
  assert.equal(client.current().dirty, true);
});

test("reordered reloads of the same file keep the newest content and hash", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const wire = transport();
  const client = createFileClient({ request: wire.request });
  client.setProject("proj_one");
  const first = client.open("a.ts", 1, true);
  const second = client.open("a.ts", 2, true);
  wire.pending[1]!.response.resolve({ path: "a.ts", content: "new", hash: "new-hash" });
  await second;
  wire.pending[0]!.response.resolve({ path: "a.ts", content: "old", hash: "old-hash" });
  await first;
  assert.equal(client.current().hash, "new-hash");
  assert.equal(client.current().line, 2);
});

test("selecting a task while offline clears the old task bundle immediately", async () => {
  const { createWorkbenchClient } = await moduleAt("state/workbench.js");
  const wire = transport();
  const client = createWorkbenchClient({ request: wire.request });
  const initial = client.selectTask("task_A"); bundle(wire.pending, "task_A", "old"); await initial;
  client.setVisible(false);
  await client.selectTask("task_B");
  assert.equal(client.state.taskId, "task_B");
  assert.equal(client.state.detail, null);
  assert.equal(client.state.proof, null);
  assert.deepEqual(client.state.events, []);
});

test("undo binds compensation to the mutation's resulting hash, including deleted files", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const bodies: any[] = [];
  const client = createFileClient({ request: async (_path: string, init: any = {}) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body); bodies.push(body);
      return { mutationId: "mut_one", hash: body.operation === "delete" ? null : "hash-new" };
    }
    return { entries: [], nextOffset: null };
  } });
  client.setProject("proj_one");
  await client.mutate({ operation: "create", path: "a.ts", content: "" }); await client.undo();
  assert.deepEqual(bodies[1], { operation: "undo", path: "a.ts", mutationId: "mut_one", expectedHash: "hash-new" });
  await client.mutate({ operation: "delete", path: "a.ts", expectedHash: "hash-new" }); await client.undo();
  assert.equal(bodies[3].expectedHash, null);
});

test("queued close events cannot cancel a newly opened permission confirmation", async () => {
  const { createDialogs } = await moduleAt("components/dialog.js");
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document;
  const handlers = new Map<string, ((event: any) => void)[]>();
  const elements: any = {};
  const element = () => ({
    isConnected: true, children: [] as any[], open: false,
    setAttribute() {}, append(...children: any[]) { this.children.push(...children); },
    replaceChildren(...children: any[]) { this.children = children; },
    focus() {}, querySelector() { return null; },
    addEventListener(kind: string, handler: any) { handlers.set(kind, [...(handlers.get(kind) ?? []), handler]); },
    showModal() { this.open = true; },
    close() { this.open = false; setImmediate(() => handlers.get("close")?.forEach((fn) => fn({}))); },
  });
  for (const id of ["modal", "modal-title", "modal-body", "modal-foot", "modal-close"]) elements[id] = element();
  globals.document = { getElementById: (id: string) => elements[id], createElement: element, activeElement: null };
  try {
    const dialogs = createDialogs();
    dialogs.open("Old preview", element());
    const confirmation = dialogs.confirm("New permission", element());
    let settled = false;
    void confirmation.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    dialogs.close(true);
    assert.equal(await confirmation, true);
  } finally { globals.document = original; }
});

function domFixture() {
  const document: any = { activeElement: null };
  const create = (tag = "div"): any => ({
    tagName: tag.toUpperCase(), value: "", dataset: {}, children: [] as any[], style: {}, attributes: {} as Record<string, string>,
    isConnected: true, disabled: false, hidden: false,
    setAttribute(key: string, value: string) { this.attributes[key] = value; if (key === "id" || key === "value") this[key] = value; },
    getAttribute(key: string) { return this.attributes[key] ?? null; },
    append(...children: any[]) { this.children.push(...children); },
    replaceChildren(...children: any[]) { this.children = children; },
    handlers: {} as Record<string, (event: any) => void>,
    addEventListener(kind: string, handler: any) { this.handlers[kind] = handler; },
    click() { this.handlers.click?.({ currentTarget: this }); },
    focus() { document.activeElement = this; },
    querySelector(selector: string) { return walk(this).find((entry) => selector.startsWith("#") ? entry.id === selector.slice(1) : entry.tagName?.toLowerCase() === selector); },
    querySelectorAll(selector: string) { return walk(this).filter((entry) => entry.tagName?.toLowerCase() === selector); },
    get options() { return this.children; },
    get textContent() { return this._text ?? this.children.map((entry: any) => typeof entry === "string" ? entry : entry.textContent ?? "").join("\n"); },
    set textContent(value: string) { this._text = value; },
  });
  document.createElement = create;
  document.getElementById = () => null;
  const walk = (root: any): any[] => root.children.flatMap((entry: any) => typeof entry === "object" ? [entry, ...walk(entry)] : []);
  return { document, create, walk };
}

test("the actual composer sends cloud attachments only after the visible confirmation", async () => {
  const { createComposer } = await moduleAt("views/composer.js");
  const { createDraftStore } = await moduleAt("state/drafts.js");
  const fixture = domFixture();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = fixture.document;
  try {
    const drafts = createDraftStore(null);
    drafts.set("proj_one", null, { request: "Inspect screen", attachmentIds: ["att_one"] });
    const state = { projectId: "proj_one", taskId: null, projects: [{ projectId: "proj_one", rootPath: "/fixture" }], run: null };
    const calls: any[] = [];
    let accept = false; let shown = "";
    const host = fixture.create();
    const settings = { config: { models: [{ id: "cloud", kind: "cloud", modelName: "vision", enabled: true, multimodal: true, endpointHost: "api.example.test" }] } };
    const composer = createComposer(host, {
      client: { state, subscribe: () => () => {} }, drafts,
      request: async (path: string, init: any = {}) => {
        calls.push({ path, init });
        if (path.startsWith("/v1/attachments?")) return { attachments: [{ attachmentId: "att_one", name: "screen.png", kind: "image", status: "ready", size: 5, contentHash: "sha256:test" }] };
        return { taskId: "task_one" };
      },
      dialogs: { confirm: async (_title: string, content: any) => { shown = content.textContent; return accept; } },
      getSettings: () => settings,
      afterStart: async () => {}, referencePicker() {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    const form = host.children[0];
    await form.onsubmit({ preventDefault() {} });
    assert.match(shown, /screen\.png/); assert.match(shown, /api\.example\.test/);
    assert.equal(calls.filter((call) => call.path === "/v1/tasks").length, 0);
    accept = true;
    await form.onsubmit({ preventDefault() {} });
    const started = calls.find((call) => call.path === "/v1/tasks");
    assert.ok(started, "confirmed attachment input reaches task submission");
    assert.equal(JSON.parse(started.init.body).allowAttachmentEgress, true);
    assert.deepEqual(JSON.parse(started.init.body).attachmentIds, ["att_one"]);
    composer.dispose();
    assert.equal(drafts.get("proj_one", null).request, "", "successful submission must not resurrect the old draft on disposal");
  } finally { globals.document = original; }
});

test("settings preserve edits entered while a saved revision is pending", async () => {
  const { createSettingsView } = await moduleAt("views/settings.js");
  const fixture = domFixture();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = fixture.document;
  try {
    const saving = deferred();
    const host = fixture.create();
    const initial = { revision: "one", config: { schemaVersion: "keystone.config@2.1.0", models: [], language: "en" }, presentation: { theme: "system", density: "comfortable" } };
    const settings = createSettingsView(host, {
      request: async (_path: string, init: any = {}) => init.method === "POST" ? saving.promise : initial,
      dialogs: {}, state: {}, capabilities: {}, onPresentation() {}, onSaved() {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    const language = host.querySelector("#settings-language");
    language.value = "zh-CN"; language.onchange();
    fixture.walk(host).find((entry) => entry.textContent === "Save and apply").click();
    language.value = "en"; language.onchange();
    saving.resolve({ ...initial, revision: "two", config: { ...initial.config, language: "zh-CN" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settings.dirty, true);
    assert.equal(host.querySelector("#settings-language").value, "en");
    settings.dispose();
  } finally { globals.document = original; }
});

test("command receipts include the built-in cmd.run action and its issued lease", async () => {
  const { renderCommands } = await moduleAt("views/task.js");
  const fixture = domFixture();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = fixture.document;
  try {
    const host = fixture.create();
    renderCommands(host, { events: [
      { type: "action.proposed", payload: { proposalId: "proposal_one", tool: { id: "cmd.run" }, parameters: { command: "node", args: ["--test"] } } },
      { type: "lease.issued", payload: { leaseId: "lease_one", capability: "cmd.exec" } },
      { type: "action.executed", payload: { proposalId: "proposal_one", leaseId: "lease_one", status: "succeeded", exitCode: 0, outputArtifactId: "artifact_one", outputBytes: 30 } },
    ] });
    assert.match(host.textContent, /cmd\.run/);
    assert.match(host.textContent, /lease_one/);
    assert.match(host.textContent, /artifact_one/);
    assert.doesNotMatch(host.textContent, /No command executions recorded/);
  } finally { globals.document = original; }
});

test("overview shows task-specific configuration and attachment provenance", async () => {
  const { renderOverview } = await moduleAt("views/task.js");
  const fixture = domFixture();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = fixture.document;
  try {
    const host = fixture.create();
    renderOverview(host, { connection: "connected", detail: {
      status: "executing", attachments: [{ name: "screen.png", mimeType: "image/png", size: 50, contentHash: "attachment-hash" }],
      configurationSnapshot: { revision: "task-revision-one", modelId: "local-model" },
    } });
    assert.match(host.textContent, /screen\.png/);
    assert.match(host.textContent, /attachment-hash/);
    assert.match(host.textContent, /task-revision-one/);
  } finally { globals.document = original; }
});

test("root file listings use the service's canonical dot path", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  let path = "";
  const client = createFileClient({ request: async (value: string) => { path = value; return { entries: [], nextOffset: null }; } });
  client.setProject("proj_one"); await client.list();
  assert.equal(new URL(path, "http://local.test").searchParams.get("path"), ".");
});

test("the runtime's explicit local route admits text attachments with an empty model config", async () => {
  const { confirmAttachmentEgress } = await moduleAt("state/composer.js");
  const grant = await confirmAttachmentEgress({ models: [] }, [{ name: "notes.txt", kind: "text" }],
    () => assert.fail("an explicit local runtime route must not ask for cloud consent"), () => true,
    [{ role: "builder", modelId: "scripted", local: true, endpointHost: "offline" }]);
  assert.deepEqual(grant, {});
});

test("rename undo binds the original source path and closes the destination tab", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const bodies: any[] = [];
  const client = createFileClient({ request: async (path: string, init: any = {}) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body); bodies.push(body);
      return { mutationId: "mut_one", hash: "same-hash", path: "a.ts" };
    }
    if (path.includes("/files?")) return { entries: [], nextOffset: null };
    return { path: "b.ts", content: "same", hash: "same-hash" };
  } });
  client.setProject("proj_one");
  await client.mutate({ operation: "rename", path: "a.ts", destination: "b.ts", expectedHash: "same-hash" });
  await client.open("b.ts");
  await client.undo();
  assert.deepEqual(bodies[1], { operation: "undo", path: "a.ts", mutationId: "mut_one", expectedHash: "same-hash" });
  assert.deepEqual(client.state.tabs, []);
});

test("a late task start does not call navigation after the selection has changed", async () => {
  const { createComposer } = await moduleAt("views/composer.js");
  const { createWorkbenchClient } = await moduleAt("state/workbench.js");
  const { createDraftStore } = await moduleAt("state/drafts.js");
  const fixture = domFixture();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = fixture.document;
  try {
    const created = deferred();
    let dispatched = false;
    const request = async () => { dispatched = true; return created.promise; };
    const client = createWorkbenchClient({ request });
    client.state.projects = [{ projectId: "proj_one", rootPath: "/fixture" }];
    client.selectProject("proj_one");
    const drafts = createDraftStore(null);
    drafts.set("proj_one", null, { request: "Inspect project" });
    let navigated = false;
    const host = fixture.create();
    const composer = createComposer(host, {
      client, request, drafts, dialogs: {}, getSettings: () => null, referencePicker() {},
      afterStart: async () => { navigated = true; },
    });
    const submitting = host.children[0].onsubmit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatched, true, "the selection changes after task creation was dispatched");
    client.selectProject("proj_two");
    created.resolve({ taskId: "task_new" }); await submitting;
    assert.equal(navigated, false);
    assert.equal(client.state.projectId, "proj_two");
    composer.dispose(); client.dispose();
  } finally { globals.document = original; }
});

test("write startup preserves the server's refuse, automatic and confirmation grades", async () => {
  const { createComposer } = await moduleAt("views/composer.js");
  const { createDraftStore } = await moduleAt("state/drafts.js");
  const fixture = domFixture();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = fixture.document;
  try {
    for (const grade of ["refuse", "auto_start", "confirm"]) {
      const drafts = createDraftStore(null);
      drafts.set("proj_one", null, { request: "Update code", access: "write", writePaths: "src/**" });
      const calls: any[] = []; let confirmations = 0;
      const host = fixture.create();
      const composer = createComposer(host, {
        client: { state: { projectId: "proj_one", taskId: null, projects: [{ projectId: "proj_one", rootPath: "/fixture" }] }, subscribe: () => () => {} },
        drafts, getSettings: () => null, referencePicker() {}, afterStart: async () => {},
        dialogs: { open() {}, confirm: async () => { confirmations += 1; return true; } },
        request: async (path: string, init: any) => {
          calls.push({ path, init });
          return path === "/v1/contract/preview" ? { risk: { decision: grade }, contract: { goal: "Update code" } } : { taskId: "task_new" };
        },
      });
      await host.children[0].onsubmit({ preventDefault() {} });
      assert.equal(calls[0].path, "/v1/contract/preview");
      const started = calls.find((call) => call.path === "/v1/tasks");
      assert.equal(!!started, grade !== "refuse");
      assert.equal(confirmations, grade === "confirm" ? 1 : 0);
      if (started) assert.equal(JSON.parse(started.init.body).startMode, grade === "auto_start" ? "auto" : "confirmed");
      composer.dispose();
    }
  } finally { globals.document = original; }
});

test("data UI shows inventory categories and uses preview before confirmed cleanup or migration", async () => {
  const { createSettingsView } = await moduleAt("views/settings.js");
  const fixture = domFixture();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = fixture.document;
  try {
    const calls: any[] = [];
    let accept = false;
    const host = fixture.create();
    const view = createSettingsView(host, {
      request: async (path: string, init: any = {}) => {
        calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
        if (path === "/v1/settings") return { revision: "one", config: { models: [] }, presentation: { theme: "system", density: "comfortable" } };
        if (path === "/v1/data") return { home: "/keystone-data", projects: [], tasks: [], artifacts: { bytes: 10 }, attachments: { bytes: 99 }, settings: { bytes: 33 }, history: { bytes: 22 }, credentials: { bytes: 5 }, totals: { bytes: 200 } };
        return { preview: JSON.parse(init.body).preview, bytes: 20, sourcePreserved: true };
      },
      dialogs: { confirm: async () => accept }, state: {}, capabilities: {}, onPresentation() {}, onSaved() {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    fixture.walk(host).find((entry) => entry.textContent === "Data and storage").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(host.textContent, /99 B/); assert.match(host.textContent, /33 B/);
    const cleanup = fixture.walk(host).find((entry) => entry.textContent === "Preview cache cleanup");
    cleanup.click(); await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.filter((entry) => entry.path === "/v1/data/cleanup").map((entry) => entry.body), [{ category: "cache", preview: true }]);
    accept = true; cleanup.click(); await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.at(-1).body, { category: "cache", preview: false });
    host.querySelector("#data-destination").value = "/new-data";
    fixture.walk(host).find((entry) => entry.textContent === "Preview migration").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.filter((entry) => entry.path === "/v1/data/migrate").map((entry) => entry.body), [
      { destination: "/new-data", preview: true }, { destination: "/new-data", preview: false },
    ]);
    view.dispose();
  } finally { globals.document = original; }
});

test("native settings keep credential setup reachable after first-run onboarding", async () => {
  const { createSettingsView } = await moduleAt("views/settings.js");
  const fixture = domFixture();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = fixture.document;
  try {
    let opened = false;
    const host = fixture.create();
    const view = createSettingsView(host, {
      request: async () => ({ revision: "one", config: { models: [] }, presentation: { theme: "system", density: "comfortable" } }),
      dialogs: {}, state: {}, capabilities: {}, shell: { hasModel: true }, onPresentation() {}, onSaved() {},
      openNativeConfiguration: () => { opened = true; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    fixture.walk(host).find((entry) => entry.textContent === "Models and routing").click();
    const setup = fixture.walk(host).find((entry) => entry.textContent === "Configure model and credential");
    assert.ok(setup, "native credential setup remains available from settings");
    setup.click(); assert.equal(opened, true);
    view.dispose();
  } finally { globals.document = original; }
});

test("explicit file reload updates the rendered editor even when the disk hash is unchanged", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const { createFilesView } = await moduleAt("views/files.js");
  const fixture = domFixture();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = fixture.document;
  try {
    const request = async (path: string) => path.includes("/files?")
      ? { entries: [], nextOffset: null } : { path: "a.ts", content: "original", hash: "same-hash", size: 8 };
    const files = createFileClient({ request });
    files.setProject("proj_one"); await files.open("a.ts");
    const host = fixture.create();
    const view = createFilesView(host, { files, request, dialogs: {}, reference() {} });
    const editor = fixture.walk(host).find((entry) => entry.tagName === "TEXTAREA");
    editor.value = "edited"; editor.oninput();
    await files.open("a.ts", 1, true);
    assert.equal(files.current().draft, "original");
    assert.equal(editor.value, "original");
    view.dispose(); files.dispose();
  } finally { globals.document = original; }
});
