import assert from "node:assert/strict";
import test from "node:test";

const moduleAt = (path: string): Promise<any> => import(new URL(`../web/${path}`, import.meta.url).href);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function domFixture() {
  const document: any = { activeElement: null };
  const walk = (root: any): any[] => root.children.flatMap((child: any) => typeof child === "object" ? [child, ...walk(child)] : []);
  const matches = (entry: any, selector: string) => selector.split(",").some((part) => {
    const value = part.trim();
    if (value.startsWith("#")) return entry.id === value.slice(1);
    if (value.startsWith(".")) return entry.className?.split(" ").includes(value.slice(1));
    return entry.tagName?.toLowerCase() === value;
  });
  const create = (tag = "div"): any => ({
    tagName: tag.toUpperCase(), children: [] as any[], attributes: {} as Record<string, string>,
    dataset: {}, disabled: false, hidden: false, open: false, isConnected: true, style: {},
    get value() { return this.tagName === "SELECT" ? this.options.find((entry: any) => entry.selected)?.value ?? "" : this._value ?? ""; },
    set value(value: string) {
      if (this.tagName !== "SELECT") { this._value = String(value); return; }
      const selected = this.options.find((entry: any) => entry.value === String(value));
      for (const entry of this.options) entry.selected = entry === selected;
    },
    get selectedIndex() { return this.options.findIndex((entry: any) => entry.selected); },
    handlers: {} as Record<string, any[]>,
    classList: { add() {}, remove() {} },
    setCustomValidity(value: string) { this.validityMessage = value; },
    reportValidity() {},
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
      if (["id", "value"].includes(key)) this[key] = value;
      if (key === "disabled") this.disabled = true;
    },
    getAttribute(key: string) { return this.attributes[key] ?? null; },
    removeAttribute(key: string) { delete this.attributes[key]; },
    append(...children: any[]) {
      this.children.push(...children);
      if (this.tagName === "SELECT" && !this.options.some((entry: any) => entry.selected)) {
        const first = this.options.find((entry: any) => !entry.disabled);
        if (first) first.selected = true;
      }
    },
    prepend(...children: any[]) { this.children.unshift(...children); },
    replaceChildren(...children: any[]) { this.children = []; this.append(...children); this._text = undefined; },
    addEventListener(kind: string, fn: any) { (this.handlers[kind] ??= []).push(fn); },
    async dispatch(kind: string, values = {}) {
      const event = { currentTarget: this, target: this, preventDefault() {}, ...values };
      await this[`on${kind}`]?.(event);
      for (const fn of this.handlers[kind] ?? []) await fn(event);
      await settle();
    },
    click() { if (!this.disabled) return this.dispatch("click"); },
    focus() { document.activeElement = this; },
    requestSubmit() { return this.onsubmit?.({ preventDefault() {} }); },
    querySelector(selector: string) { return walk(this).find((entry) => matches(entry, selector)); },
    querySelectorAll(selector: string) { return walk(this).filter((entry) => matches(entry, selector)); },
    get options() { return this.children; },
    get firstChild() { return this.children[0]; },
    get lastChild() { return this.children.at(-1); },
    get textContent() { return this._text ?? this.children.map((child: any) => typeof child === "string" ? child : child.textContent ?? "").join("\n"); },
    set textContent(value: string) { this._text = String(value); this.children = []; },
  });
  const root = create();
  document.createElement = create;
  document.getElementById = (id: string) => root.querySelector(`#${id}`);
  return { document, root, create, walk };
}

async function inDom(action: (f: ReturnType<typeof domFixture>) => Promise<void>) {
  const f = domFixture();
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ document: f.document, KEYSTONE_I18N: {} })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try { await action(f); } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const findButton = (host: any, label: string) => host.querySelectorAll("button").find((entry: any) => entry.textContent === label);

async function composerFixture(f: ReturnType<typeof domFixture>, overrides: any = {}) {
  const { createComposer } = await moduleAt("views/composer.js");
  const { createDraftStore } = await moduleAt("state/drafts.js");
  const calls: any[] = []; const listeners = new Set<any>();
  const client = { selectionVersion: 1, state: { projectId: "p", taskId: null, projects: [{ projectId: "p", rootPath: "/project" }], detail: null, run: null },
    subscribe(fn: any) { listeners.add(fn); return () => listeners.delete(fn); } };
  const config = { config: { models: [
    { id: "local", kind: "local", modelName: "Local model", enabled: true, multimodal: false },
    { id: "cloud", kind: "cloud", modelName: "Cloud model", endpointHost: "api.example.com", enabled: true, multimodal: true },
  ], routes: { builder: ["local"] } } };
  const request = async (path: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined; calls.push({ path, body });
    if (path.includes("input-processors")) return { processors: [] };
    if (path.includes("preview")) return { risk: { decision: "confirm" }, contract: {} };
    return { taskId: "started" };
  };
  const host = f.create(); f.root.append(host);
  const drafts = overrides.drafts ?? createDraftStore(null);
  const composer = createComposer(host, {
    client, request, drafts, dialogs: { confirm: async () => true, open() {} }, getSettings: () => config, getEgress: () => [],
    afterStart: async () => {}, referencePicker() {}, ...overrides,
  });
  await settle();
  return { host, client, calls, config, composer, drafts, emit: () => listeners.forEach((fn) => fn()) };
}

test("the composer fixture discards select values without matching options like a native select", () => {
  const f = domFixture();
  const select = f.create("select");
  select.value = "cloud";
  assert.equal(select.value, "");
  assert.equal(select.selectedIndex, -1);
  select.append(Object.assign(f.create("option"), { value: "local" }), Object.assign(f.create("option"), { value: "cloud", disabled: true }));
  assert.equal(select.value, "local");
  select.value = "missing";
  assert.equal(select.value, "");
  assert.equal(select.selectedIndex, -1);
  select.value = "cloud";
  assert.equal(select.value, "cloud");
  assert.equal(select.selectedIndex, 1);
});

test("reloading a persisted composer draft restores a non-default model and submits its modelId", async () => {
  const { createDraftStore } = await moduleAt("state/drafts.js");
  await inDom(async (f) => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    const first = await composerFixture(f, { drafts: createDraftStore(storage) });
    const input = first.host.querySelector("#composer-input");
    input.value = "Explain this project"; await input.dispatch("input");
    const model = first.host.querySelector("#composer-model");
    model.value = "cloud"; await model.dispatch("change");
    first.composer.dispose();
    const drafts = createDraftStore(storage);
    assert.equal(drafts.get("p", null).modelId, "cloud");
    const reloaded = await composerFixture(f, { drafts });
    try {
      const restored = reloaded.host.querySelector("#composer-model");
      assert.equal(restored.value, "cloud");
      assert.equal(restored.options[restored.selectedIndex].value, "cloud");
      assert.equal(reloaded.host.querySelector("#composer-input").value, "Explain this project");
      await reloaded.host.querySelector("form").onsubmit({ preventDefault() {} });
      assert.equal(reloaded.calls.find((entry) => entry.path === "/v1/tasks").body.modelId, "cloud");
    } finally { reloaded.composer.dispose(); }
  });
});

test("restored disabled or missing models stay selected and block default-route submission", async () => {
  const { createDraftStore } = await moduleAt("state/drafts.js");
  await inDom(async (f) => {
    for (const disabled of [false, true]) {
      const drafts = createDraftStore(null);
      drafts.set("p", null, { request: "Explain", modelId: "unavailable" });
      const config = { config: { models: [
        { id: "local", modelName: "Default model", enabled: true, kind: "local" },
        ...(disabled ? [{ id: "unavailable", modelName: "Chosen model", enabled: false, kind: "cloud" }] : []),
      ], routes: { builder: ["local"] } } };
      const c = await composerFixture(f, { drafts, getSettings: () => config,
        getEgress: () => disabled ? [{ role: "builder", modelId: "unavailable", endpointHost: "api.example.com" }] : [] });
      try {
        const model = c.host.querySelector("#composer-model");
        assert.equal(model.value, "unavailable");
        assert.equal(model.options[model.selectedIndex].disabled, true);
        assert.match(model.options[model.selectedIndex].textContent, /Disabled|unavailable/);
        assert.equal(findButton(c.host, "Start task").disabled, true);
        await c.host.querySelector("form").onsubmit({ preventDefault() {} });
        assert.equal(c.calls.some((entry) => entry.path === "/v1/tasks"), false);
        const input = c.host.querySelector("#composer-input");
        input.value = "Keep this choice"; await input.dispatch("input"); c.composer.refresh();
        assert.equal(drafts.get("p", null).modelId, "unavailable");
        model.value = "local"; await model.dispatch("change");
        assert.equal(findButton(c.host, "Start task").disabled, false);
        await c.host.querySelector("form").onsubmit({ preventDefault() {} });
        assert.equal(c.calls.find((entry) => entry.path === "/v1/tasks").body.modelId, "local");
      } finally { c.composer.dispose(); }
    }
  });
});

test("models loaded after draft restoration resolve the saved choice without falling back", async () => {
  const { createDraftStore } = await moduleAt("state/drafts.js");
  await inDom(async (f) => {
    const drafts = createDraftStore(null);
    drafts.set("p", null, { request: "Explain", modelId: "cloud" });
    let config: any = undefined;
    const c = await composerFixture(f, { drafts, getSettings: () => config });
    try {
      const model = c.host.querySelector("#composer-model");
      assert.equal(model.value, "cloud");
      assert.equal(findButton(c.host, "Start task").disabled, true);
      config = c.config; c.composer.refresh(); c.emit(); await settle();
      assert.equal(model.value, "cloud");
      assert.equal(model.options[model.selectedIndex].disabled, false);
      assert.equal(findButton(c.host, "Start task").disabled, false);
      await c.host.querySelector("form").onsubmit({ preventDefault() {} });
      assert.equal(c.calls.find((entry) => entry.path === "/v1/tasks").body.modelId, "cloud");
    } finally { c.composer.dispose(); }
  });
});

test("late draft attachment and processor loads preserve a newer user model selection", async () => {
  const { createDraftStore } = await moduleAt("state/drafts.js");
  await inDom(async (f) => {
    const drafts = createDraftStore(null);
    drafts.set("p", null, { request: "Explain", modelId: "cloud", attachmentIds: ["a"] });
    let finishAttachments!: (value: any) => void;
    let finishProcessors!: (value: any) => void;
    const c = await composerFixture(f, { drafts, request: (path: string) => path.startsWith("/v1/attachments?")
      ? new Promise((resolve) => { finishAttachments = resolve; })
      : new Promise((resolve) => { finishProcessors = resolve; }) });
    try {
      const model = c.host.querySelector("#composer-model");
      assert.equal(model.value, "cloud");
      assert.ok(model.options.some((entry: any) => entry.value === "local"));
      model.value = "local"; await model.dispatch("change");
      c.emit(); c.composer.refresh();
      finishAttachments({ attachments: [{ attachmentId: "a", name: "note.txt", mimeType: "text/plain", size: 1, kind: "text", status: "ready" }] });
      await settle();
      finishProcessors({ processors: [] }); await settle();
      assert.equal(model.value, "local");
      assert.equal(drafts.get("p", null).modelId, "local");
    } finally { c.composer.dispose(); }
  });
});

test("restoring task-bound drafts leaves active and revision model snapshots unchanged", async () => {
  const { createDraftStore } = await moduleAt("state/drafts.js");
  await inDom(async (f) => {
    const drafts = createDraftStore(null);
    drafts.set("p", null, { request: "New request", modelId: "cloud" });
    drafts.set("p", "t", { request: "Revised request", reason: "Clarify outcome", modelId: "gone" });
    const c = await composerFixture(f, { drafts });
    try {
      const snapshot = { builderModelId: "bound-model" };
      Object.assign(c.client.state, { taskId: "t", detail: { contract: { goal: "Original" }, configurationSnapshot: snapshot }, run: { status: "running" } });
      c.emit(); await settle();
      const model = c.host.querySelector("#composer-model");
      assert.equal(model.value, "cloud");
      assert.equal(model.disabled, false);
      const operation = c.host.querySelector("#composer-operation");
      operation.value = "revise"; await operation.dispatch("change");
      assert.equal(model.disabled, true);
      assert.equal(model.value, "gone");
      assert.equal(model.options[model.selectedIndex].textContent, "bound-model");
      await c.host.querySelector("form").onsubmit({ preventDefault() {} });
      const revision = c.calls.find((entry) => entry.path === "/v1/tasks/t/contract");
      assert.deepEqual(revision.body, { goal: "Revised request", writePaths: [], reason: "Clarify outcome" });
      assert.deepEqual(snapshot, { builderModelId: "bound-model" });
      c.composer.newTask(); await settle();
      assert.equal(model.value, "cloud");
      assert.equal(model.disabled, false);
      assert.equal(c.calls.some((entry) => entry.path === "/v1/tasks"), false);
    } finally { c.composer.dispose(); }
  });
});

test("composer gates empty input and a known missing route with actionable feedback", async () => {
  await inDom(async (f) => {
    const c = await composerFixture(f, { getSettings: () => ({ config: { models: [], routes: {} } }) });
    const input = c.host.querySelector("#composer-input");
    assert.equal(findButton(c.host, "Start task").disabled, true);
    input.value = "Understand this project"; await input.dispatch("input");
    assert.equal(findButton(c.host, "Start task").disabled, true);
    assert.match(c.host.textContent, /Configure a model/);
    await c.host.querySelector("form").onsubmit({ preventDefault() {} });
    assert.equal(c.calls.some((entry) => entry.path === "/v1/tasks"), false);
    c.composer.dispose();
  });
});

test("composer submits analysis or engineering and a selected optional model without changing active tasks", async () => {
  await inDom(async (f) => {
    const c = await composerFixture(f); const input = c.host.querySelector("#composer-input");
    input.value = "Explain @src/a.ts"; await input.dispatch("input");
    const model = c.host.querySelector("#composer-model");
    assert.ok(model); model.value = "cloud"; await model.dispatch("change");
    await c.host.querySelector("form").onsubmit({ preventDefault() {} });
    assert.equal(c.calls.at(-1).body.taskIntent, "analysis"); assert.equal(c.calls.at(-1).body.modelId, "cloud");
    assert.deepEqual(c.calls.at(-1).body.writePaths, []);
    c.composer.newTask(); await settle();
    input.value = "Update a.ts"; await input.dispatch("input");
    const access = c.host.querySelectorAll("select").find((entry: any) => entry.getAttribute("aria-label") === "Task access");
    access.value = "write"; await access.dispatch("input");
    c.host.querySelector("#composer-write").value = "src/a.ts";
    model.value = ""; await model.dispatch("change");
    await c.host.querySelector("form").onsubmit({ preventDefault() {} });
    const body = c.calls.findLast((entry) => entry.path === "/v1/tasks").body;
    assert.equal(body.taskIntent, "engineering"); assert.equal(Object.hasOwn(body, "modelId"), false);
    c.composer.dispose();
  });
});

test("changing the upcoming model cancels an in-flight scope confirmation", async () => {
  let answer!: (value: boolean) => void;
  await inDom(async (f) => {
    const c = await composerFixture(f, { dialogs: { confirm: () => new Promise((resolve) => { answer = resolve; }), open() {} } });
    const input = c.host.querySelector("#composer-input"); input.value = "Edit"; await input.dispatch("input");
    const access = c.host.querySelectorAll("select").find((entry: any) => entry.getAttribute("aria-label") === "Task access");
    access.value = "write"; c.host.querySelector("#composer-write").value = "src/**";
    const pending = c.host.querySelector("form").onsubmit({ preventDefault() {} }); await settle();
    c.host.querySelector("#composer-model").value = "cloud"; await c.host.querySelector("#composer-model").dispatch("change");
    answer(true); await pending;
    assert.equal(c.calls.some((entry) => entry.path === "/v1/tasks"), false);
    assert.equal(input.value, "Edit"); c.composer.dispose();
  });
});

test("egress preview and image consent reflect only the explicitly selected upcoming model", async () => {
  await inDom(async (f) => {
    let shown = "";
    const c = await composerFixture(f, { dialogs: {
      open(_title: string, body: any) { shown = body.textContent; },
      confirm: async () => true, close() {},
    } });
    const model = c.host.querySelector("#composer-model"); model.value = "cloud"; await model.dispatch("change");
    await findButton(c.host, "Egress preview").click();
    assert.match(shown, /api.example.com/); assert.doesNotMatch(shown, /"id": "local"/);
    c.composer.dispose();
  });
});

test("the model menu names the effective default and retains disabled models with their reason", async () => {
  await inDom(async (f) => {
    const config = { config: { models: [
      { id: "one", modelName: "Effective model", enabled: true, kind: "cloud" },
      { id: "off", modelName: "Disabled model", enabled: false, kind: "local" },
    ], routes: { builder: ["one"] } } };
    const c = await composerFixture(f, { getSettings: () => config });
    const model = c.host.querySelector("#composer-model");
    assert.match(model.options[0].textContent, /Effective model/); assert.match(model.options[0].textContent, /Cloud/);
    assert.equal(model.options.find((entry: any) => entry.value === "off").disabled, true);
    c.composer.dispose();
  });
});

test("cloud image consent is bound to the selected image-capable model, not the default text route", async () => {
  const { confirmAttachmentEgress, imageRouteWarning } = await moduleAt("state/composer.js");
  const config = { models: [
    { id: "text", enabled: true, kind: "local", multimodal: false },
    { id: "vision", enabled: true, kind: "cloud", endpointHost: "api.example.com", multimodal: true },
  ], routes: { builder: ["text"] } };
  const attachments = [{ attachmentId: "a", name: "image.png", kind: "image", size: 1 }];
  let destination: any;
  assert.equal(imageRouteWarning(config, attachments, [], "vision"), null);
  assert.notEqual(imageRouteWarning(config, attachments, [], "text"), null);
  assert.deepEqual(await confirmAttachmentEgress(config, attachments, async (plan: any) => { destination = plan; return true; }, () => true, [], "vision"), { allowAttachmentEgress: true });
  assert.equal(destination.destinations[0].id, "vision");
  assert.equal(destination.destinations.length, 1);
});

test("late accepted task creation cannot clear newer model or scope edits", async () => {
  await inDom(async (f) => {
    let finish!: (value: any) => void;
    const c = await composerFixture(f, { request: async (path: string) => path === "/v1/tasks"
      ? new Promise((resolve) => { finish = resolve; }) : { processors: [] } });
    const input = c.host.querySelector("#composer-input"); input.value = "Explain"; await input.dispatch("input");
    const pending = c.host.querySelector("form").onsubmit({ preventDefault() {} }); await settle();
    const model = c.host.querySelector("#composer-model"); model.value = "cloud"; await model.dispatch("change");
    finish({ taskId: "started" }); await pending;
    assert.equal(c.drafts.get("p", null).modelId, "cloud");
    assert.equal(c.drafts.get("p", null).request, "Explain"); c.composer.dispose();
  });
});

test("switching input operation disables model changes without replacing the active task model", async () => {
  await inDom(async (f) => {
    const c = await composerFixture(f);
    Object.assign(c.client.state, { taskId: "t", detail: { contract: { goal: "goal" }, configurationSnapshot: { builderModelId: "bound-model" } }, run: { status: "running" } });
    const operation = c.host.querySelector("#composer-operation"); operation.value = "revise"; await operation.dispatch("change");
    assert.equal(c.host.querySelector("#composer-model").disabled, true);
    assert.match(c.host.querySelector("#composer-model").textContent, /bound-model/);
    c.composer.dispose();
  });
});

test("IME composition never submits, modifier Enter submits once, and failed submissions remain retryable", async () => {
  await inDom(async (f) => {
    let submits = 0;
    const c = await composerFixture(f, { request: async (path: string) => {
      if (path === "/v1/tasks") { submits += 1; if (submits === 1) throw new Error("temporarily unavailable"); }
      return { taskId: "ok", processors: [] };
    } });
    const input = c.host.querySelector("#composer-input"); input.value = "Explain"; await input.dispatch("input");
    await input.dispatch("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
    assert.equal(submits, 0);
    await input.dispatch("compositionstart"); await input.dispatch("keydown", { key: "Enter", metaKey: true });
    assert.equal(submits, 0);
    await input.dispatch("compositionend"); await input.dispatch("keydown", { key: "Enter", ctrlKey: true });
    assert.equal(submits, 1); assert.equal(input.value, "Explain"); assert.match(c.host.textContent, /temporarily unavailable/);
    await input.dispatch("keydown", { key: "Enter", metaKey: true }); assert.equal(submits, 2);
    c.composer.dispose();
  });
});

test("open input menus suppress modifier submission and route refresh updates the visible default", async () => {
  await inDom(async (f) => {
    const c = await composerFixture(f); const input = c.host.querySelector("#composer-input");
    input.value = "Explain"; await input.dispatch("input");
    const menu = c.host.querySelector(".composer-input-menu"); menu.open = true;
    await input.dispatch("keydown", { key: "Enter", ctrlKey: true });
    assert.equal(c.calls.some((entry) => entry.path === "/v1/tasks"), false);
    c.config.config.routes.builder = ["cloud"]; c.composer.refresh();
    assert.match(c.host.querySelector("#composer-model").options[0].textContent, /Cloud model/);
    c.composer.dispose();
  });
});

test("example tasks only fill editable drafts and never submit", async () => {
  await inDom(async (f) => {
    const c = await composerFixture(f);
    assert.equal(c.composer.example("Explain the project entry points"), true);
    assert.equal(c.host.querySelector("#composer-input").value, "Explain the project entry points");
    assert.equal(c.calls.some((entry) => entry.path === "/v1/tasks"), false);
    assert.equal(c.composer.example("Replace silently"), false);
    c.composer.dispose();
  });
});

test("model code-copy and file draft export use exact local text, never remote resources", async () => {
  const { modelMessage } = await moduleAt("components/model-message.js");
  const { exportText } = await moduleAt("components/clipboard.js");
  await inDom(async (f) => {
    const copied: string[] = []; const blobs: Blob[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const make = URL.createObjectURL; const revoke = URL.revokeObjectURL;
    try {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => copied.push(value) } } });
      URL.createObjectURL = (blob: Blob) => { blobs.push(blob); return "blob:local"; }; URL.revokeObjectURL = () => {};
      const message = modelMessage({ text: "```ts\nconst value = 1;\n```", modelId: "m" });
      await findButton(message, "Copy code").click();
      assert.deepEqual(copied, ["const value = 1;"]);
      exportText("src/a.ts", "unsaved exact text");
      assert.equal(await blobs[0]!.text(), "unsaved exact text");
    } finally {
      URL.createObjectURL = make; URL.revokeObjectURL = revoke;
      if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor); else Reflect.deleteProperty(globalThis, "navigator");
    }
  });
});

test("model messages render readable untrusted text with inert markup, code copy and bounded local references", async () => {
  const { renderOverview } = await moduleAt("views/task.js");
  await inDom(async (f) => {
    const host = f.create(); const opened: any[] = [];
    renderOverview(host, { connection: "connected", events: [], detail: { status: "exited_gracefully", taskIntent: "analysis", request: "Explain", messages: [{
      text: "# Findings\n- See @src/a.ts:12\n\n```js\nconst x = '<script>alert(1)</script>';\n```\n<img src=\"https://remote.test/x\"><script>alert(1)</script>\n![image](https://remote.test/image)\n@../secret:1 @https://remote.test/file",
      modelId: "model", at: "2026-10-22T00:00:00Z", trustLevel: "untrusted", artifactId: "artifact", contentHash: "hash",
    }] } }, { openFile: (...args: any[]) => opened.push(args) });
    assert.match(host.textContent, /Analysis result/); assert.match(host.textContent, /Model output/);
    assert.equal(host.querySelectorAll("img,script,a").length, 0);
    assert.equal(host.querySelector(".model-message").querySelector("h3").textContent, "Findings");
    assert.ok(findButton(host, "Copy code"));
    assert.match(host.textContent, /artifact/); assert.match(host.textContent, /hash/);
    await findButton(host, "src/a.ts:12").click();
    assert.deepEqual(opened, [["src/a.ts", 12]]);
    assert.equal(host.querySelectorAll("button").some((entry: any) => entry.textContent.includes("secret")), false);
    assert.doesNotMatch(host.textContent, /Safe to deliver/);
  });
});

test("message projection falls back to recorded events without duplicating detail messages", async () => {
  const { renderOverview } = await moduleAt("views/task.js");
  await inDom(async (f) => {
    const host = f.create();
    const events = [{ type: "model.response_recorded", at: "now", payload: { text: "Recorded answer", modelId: "m", artifactId: "a", contentHash: "h", trustLevel: "untrusted" } }];
    const state: any = { events, detail: { status: "executing", taskIntent: "analysis" } };
    renderOverview(host, state); assert.match(host.textContent, /Recorded answer/);
    state.detail.messages = [events[0]!.payload]; renderOverview(host, state);
    assert.equal(host.querySelectorAll(".model-message").length, 1);
  });
});

test("intervention choices preserve exact grants, localize only built-ins and retain retryable rationale", async () => {
  const { renderInspector } = await moduleAt("views/task.js");
  const { createDraftStore } = await moduleAt("state/drafts.js");
  await inDom(async (f) => {
    for (const id of ["proof-summary", "decisions", "evidence", "checkpoints", "cognition"]) f.root.append(Object.assign(f.create(), { id }));
    (globalThis as any).KEYSTONE_I18N = { "Allow {target}": "允许 {target}", "Find an alternative inside the current scope": "在当前范围内寻找替代方案" };
    const intervention = {
      interventionId: "i", question: "Custom model question stays unchanged", whyUserNeeded: "Custom reason", ifIgnoredImpact: "Custom impact",
      recommendedAction: { optionId: "allow", rationale: "Custom rationale" },
      options: [
        { optionId: "allow", label: "Allow src/a.ts", grants: ["fs.write"], effectOnScope: "as recommended by the system" },
        { optionId: "alternative", label: "Find an alternative inside the current scope", grants: [] },
        { optionId: "stop", label: "Stop and hand back what has been verified so far", grants: [] },
      ],
    };
    const state = { projectId: "p", taskId: "t", events: [], checkpoints: [], connection: "connected", run: { pendingInterventions: [intervention] } };
    const calls: any[] = []; let fail = true; let finish!: (value: any) => void;
    const request = async (path: string, init: any) => {
      calls.push({ path, body: JSON.parse(init.body) });
      if (fail) throw new Error("retry decision");
      return new Promise((resolve) => { finish = resolve; });
    };
    renderInspector(state, { request, drafts: createDraftStore(null), dialogs: { confirm: async () => true }, refresh: async () => {} });
    const host = f.root.querySelector("#decisions"); const reason = host.querySelector("textarea"); reason.value = "Human reason";
    assert.match(host.textContent, /Custom model question stays unchanged/);
    await findButton(host, "允许 src/a.ts").click();
    assert.equal(calls[0].body.grants, "fs.write"); assert.equal(calls[0].body.optionId, "allow"); assert.match(host.textContent, /retry decision/);
    assert.equal(reason.value, "Human reason"); fail = false;
    const pending = findButton(host, "在当前范围内寻找替代方案").click(); await settle();
    assert.equal(host.querySelectorAll("button").every((entry: any) => entry.disabled), true);
    assert.equal(calls[1].body.decision, "deny"); assert.equal(Object.hasOwn(calls[1].body, "grants"), false);
    finish({ recorded: true }); await pending;
  });
});

test("named ambiguity alternatives preserve option identity without inventing permissions", async () => {
  const { renderInspector } = await moduleAt("views/task.js");
  const { createDraftStore } = await moduleAt("state/drafts.js");
  await inDom(async (f) => {
    for (const id of ["proof-summary", "decisions", "evidence", "checkpoints", "cognition"]) f.root.append(Object.assign(f.create(), { id }));
    const state = { projectId: "p", taskId: "t", events: [], checkpoints: [], connection: "connected", run: { pendingInterventions: [{
      interventionId: "i", trigger: "ambiguity", question: "Which approach?", recommendedAction: { optionId: "one", rationale: "Model rationale" },
      options: [{ optionId: "one", label: "Keep existing", grants: [] }, { optionId: "two", label: "Use the alternative", grants: [] },
        { optionId: "many", label: "Multiple capabilities", grants: ["fs.write", "net.fetch"] }],
    }] } };
    let body: any;
    renderInspector(state, { request: async (_path: string, init: any) => { body = JSON.parse(init.body); return { recorded: true }; },
      drafts: createDraftStore(null), dialogs: {}, refresh: async () => {} });
    const host = f.root.querySelector("#decisions"); host.querySelector("textarea").value = "I select the alternative";
    await findButton(host, "Use the alternative").click();
    assert.equal(body.optionId, "two"); assert.equal(body.decision, "modify"); assert.equal(Object.hasOwn(body, "grants"), false);
    assert.equal(findButton(host, "Multiple capabilities").disabled, true);
  });
});

test("intervention localization uses built-in context and never rewrites ambiguity model text", async () => {
  const { interventionText } = await moduleAt("state/interventions.js");
  await inDom(async () => {
    (globalThis as any).KEYSTONE_I18N = { "Allow {target}": "允许 {target}", "the task cannot proceed without this decision": "需要决策才能继续" };
    assert.equal(interventionText("Allow src/a.ts", "scope_expansion"), "允许 src/a.ts");
    assert.equal(interventionText("Allow src/a.ts", "ambiguity"), "Allow src/a.ts");
    assert.equal(interventionText("the task cannot proceed without this decision"), "需要决策才能继续");
  });
});

test("Chinese product surfaces translate guidance and preserve model-language content", async () => {
  const { workbench } = await import("../../i18n/src/catalog/zh-CN/workbench.ts");
  const { modelMessage } = await moduleAt("components/model-message.js");
  await inDom(async (f) => {
    (globalThis as any).KEYSTONE_I18N = workbench;
    const c = await composerFixture(f, { getSettings: () => ({ config: { models: [] } }) });
    assert.match(c.host.textContent, /先配置模型再开始任务/);
    assert.doesNotMatch(c.host.textContent, /Configure a model before/);
    const message = modelMessage({ text: "Keep this model answer in English.", modelId: "m" });
    assert.match(message.textContent, /模型输出/); assert.match(message.textContent, /Keep this model answer in English/);
    c.composer.dispose();
  });
});

test("CLI plugin status never probes implicitly and unsupported services retain an explicit retry", async () => {
  const { createModelPluginView } = await moduleAt("views/model-plugin.js");
  await inDom(async (f) => {
    const calls: any[] = [];
    const host = f.create();
    const view = createModelPluginView(host, { request: async (path: string, init: any = {}) => {
      calls.push({ path, init }); throw Object.assign(new Error("unsupported"), { status: 404 });
    }, dialogs: {}, onEnabled() {} });
    await settle();
    assert.equal(calls.length, 1); assert.equal(calls[0].init.method, undefined);
    assert.match(host.textContent, /unavailable/); assert.ok(findButton(host, "Retry plugin status"));
    assert.equal(findButton(host, "Discover CLI models").disabled, true);
    view.dispose();
  });
});

test("CLI discovery, generation probe and activation require separate explicit confirmation and exact destinations", async () => {
  const { createModelPluginView } = await moduleAt("views/model-plugin.js");
  await inDom(async (f) => {
    const calls: any[] = []; const confirmations: string[] = []; let enabled = 0;
    const host = f.create(); let accepted = false;
    const request = async (path: string, init: any = {}) => {
      calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
      if (path.endsWith("/discover")) return { supported: true, cliPath: "/usr/local/bin/trae-cli", version: "1", models: [{ id: "model-a", name: "Model A", available: true }] };
      if (path.endsWith("/probe")) return { ok: true, modelId: "model-a" };
      if (path.endsWith("/enable")) return { enabled: true };
      return { supported: true, enabled: false };
    };
    const view = createModelPluginView(host, { request, dialogs: { confirm: async (_title: string, body: any) => {
      confirmations.push(body.textContent); return accepted;
    } }, onEnabled: async () => { enabled += 1; } });
    await settle(); assert.equal(calls.length, 1);
    host.querySelector("#trae-endpoint").value = "api.example.com";
    host.querySelector("#trae-egress").value = "api.example.com, auth.example.com";
    await findButton(host, "Discover CLI models").click(); assert.equal(calls.length, 1);
    accepted = true; await findButton(host, "Discover CLI models").click();
    assert.equal(calls.at(-1).path.endsWith("/discover"), true);
    assert.equal(calls.at(-1).body.confirmed, true);
    assert.deepEqual(calls.at(-1).body.egressHosts, ["api.example.com", "auth.example.com"]);
    await findButton(host, "Generation check").click();
    assert.equal(calls.at(-1).path.endsWith("/probe"), true); assert.equal(calls.at(-1).body.modelId, "model-a");
    assert.match(confirmations.at(-1)!, /usage/); assert.match(confirmations.at(-1)!, /api.example.com/);
    await findButton(host, "Enable for new tasks").click();
    assert.equal(calls.at(-1).path.endsWith("/enable"), true); assert.equal(enabled, 1);
    view.dispose();
  });
});

test("plugin failed generation checks cannot reuse an earlier successful activation gate", async () => {
  const { createModelPluginView } = await moduleAt("views/model-plugin.js");
  await inDom(async (f) => {
    let fail = false; const host = f.create();
    const view = createModelPluginView(host, { dialogs: { confirm: async () => true }, request: async (path: string) => {
      if (path.endsWith("/discover")) return { models: [{ id: "m" }] };
      if (path.endsWith("/probe")) { if (fail) throw new Error("probe failed"); return { ok: true }; }
      return { supported: true };
    } });
    await settle();
    host.querySelector("#trae-endpoint").value = "api.example.com"; host.querySelector("#trae-egress").value = "api.example.com";
    await findButton(host, "Discover CLI models").click(); await findButton(host, "Generation check").click();
    assert.equal(findButton(host, "Enable for new tasks").disabled, false);
    fail = true; await findButton(host, "Generation check").click();
    assert.equal(findButton(host, "Enable for new tasks").disabled, true);
    view.dispose();
  });
});

test("plugin destination edits invalidate pending confirmation and never launch the old operation", async () => {
  const { createModelPluginView } = await moduleAt("views/model-plugin.js");
  await inDom(async (f) => {
    let answer!: (value: boolean) => void; const calls: any[] = [];
    const host = f.create();
    const view = createModelPluginView(host, {
      request: async (path: string, init: any = {}) => { calls.push(init); return { supported: true }; },
      dialogs: { confirm: () => new Promise((resolve) => { answer = resolve; }) }, onEnabled() {},
    });
    await settle();
    host.querySelector("#trae-endpoint").value = "api.example.com"; host.querySelector("#trae-egress").value = "api.example.com";
    const pending = findButton(host, "Discover CLI models").click(); await settle();
    host.querySelector("#trae-endpoint").value = "different.example.com";
    answer(true); await pending;
    assert.equal(calls.length, 1); view.dispose();
  });
});

test("getting-started actions show missing prerequisites and examples never start a task", async () => {
  const { createGettingStarted } = await moduleAt("components/getting-started.js");
  await inDom(async (f) => {
    const host = f.create(); const actions: string[] = [];
    const view = createGettingStarted(host, {
      addProject: () => actions.push("project"), configureModel: () => actions.push("http"), openPlugin: () => actions.push("plugin"),
      example: (value: string) => actions.push(value),
    });
    view.update({ project: null, models: [] });
    assert.match(host.textContent, /Add a local project/); assert.match(host.textContent, /Connect a model/);
    await findButton(host, "Connect HTTP model").click(); await findButton(host, "TRAE CLI model").click();
    await findButton(host, "Explain code").click();
    assert.equal(actions[0], "http"); assert.equal(actions[1], "plugin"); assert.match(actions[2]!, /Explain/);
    view.update({ project: { name: "Project" }, models: [{ modelName: "Model", kind: "cloud" }] });
    assert.equal(host.querySelector(".setup-steps").hidden, true);
    assert.match(host.textContent, /Model/);
  });
});

test("model settings show CLI transports read-only and open model setup directly", async () => {
  const { createSettingsView } = await moduleAt("views/settings.js");
  await inDom(async (f) => {
    const host = f.create(); let opened = 0; const calls: string[] = [];
    const view = createSettingsView(host, {
      initialPage: "models", openModelPlugins: () => { opened += 1; }, dialogs: {},
      state: { projects: [] }, capabilities: {}, onPresentation() {}, onSaved() {},
      request: async (path: string) => { calls.push(path); return { revision: "r", presentation: {}, config: { models: [
        { id: "trae-cli:model", modelName: "CLI model", protocol: "trae-cli-exec", kind: "cloud", enabled: true, endpointHost: "api.example.com" },
      ] } }; },
    });
    await settle();
    assert.match(host.textContent, /CLI model/); assert.match(host.textContent, /managed by the CLI plugin/);
    assert.equal(host.querySelector("#protocol-trae-cli:model"), undefined);
    await findButton(host, "Manage CLI models").click(); assert.equal(opened, 1);
    assert.deepEqual(calls, ["/v1/settings"]); view.dispose();
  });
});

test("file recovery view requires an explicit choice and shows conflicting contents before recovery", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const { createFilesView } = await moduleAt("views/files.js");
  await inDom(async (f) => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    let disk = { path: "a.ts", content: "old", hash: "old-hash" };
    const request = async (path: string) => path.includes("/files?") ? { entries: [] } : disk;
    const first = createFileClient({ request, storage }); first.setProject("p"); await first.open("a.ts"); first.edit("unsaved");
    disk = { ...disk, content: "external", hash: "external-hash" };
    const files = createFileClient({ request, storage }); files.setProject("p"); await files.open("a.ts");
    const host = f.create(); let accepted = false; let shown = "";
    const view = createFilesView(host, {
      files, request, reference() {},
      dialogs: { confirm: async (_title: string, content: any) => { shown = content.textContent; return accepted; } },
    });
    assert.ok(findButton(host, "Recover file draft"));
    assert.ok(findButton(host, "Discard file draft"));
    assert.equal(host.querySelector("textarea").readOnly, true);
    await findButton(host, "Recover file draft").click();
    assert.match(shown, /unsaved/); assert.match(shown, /external/);
    assert.equal(files.current().draft, "external");
    host.querySelector("textarea").focus();
    accepted = true; await findButton(host, "Recover file draft").click();
    assert.equal(files.current().draft, "unsaved");
    assert.equal(host.querySelector("textarea").value, "unsaved");
    assert.equal(host.querySelector("textarea").readOnly, false);
    view.dispose(); files.dispose();
  });
});

test("typing while file discard confirmation is pending preserves the newer draft", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const { createFilesView } = await moduleAt("views/files.js");
  await inDom(async (f) => {
    const request = async (path: string) => path.includes("/files?") ? { entries: [] } : { path: "a.ts", content: "old", hash: "h" };
    const files = createFileClient({ request }); files.setProject("p"); await files.open("a.ts"); files.edit("first");
    let answer!: (value: boolean) => void; const host = f.create();
    const view = createFilesView(host, { files, request, reference() {}, dialogs: { confirm: () => new Promise((resolve) => { answer = resolve; }) } });
    const pending = findButton(host, "Close file").click(); await settle();
    files.edit("newer"); answer(true); await pending;
    assert.equal(files.current().draft, "newer");
    view.dispose(); files.dispose();
  });
});

test("storage failure view offers draft export without claiming persistence", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const { createFilesView } = await moduleAt("views/files.js");
  await inDom(async (f) => {
    const request = async (path: string) => path.includes("/files?") ? { entries: [] } : { path: "a.ts", content: "old", hash: "old" };
    const files = createFileClient({ request, storage: null }); files.setProject("p"); await files.open("a.ts");
    const host = f.create();
    const view = createFilesView(host, { files, request, dialogs: {}, reference() {} });
    const editor = host.querySelector("textarea"); editor.value = "unpersisted"; editor.oninput();
    assert.match(host.textContent, /Copy or export your draft before leaving/);
    assert.ok(findButton(host, "Copy file draft"));
    assert.ok(findButton(host, "Export file draft"));
    view.dispose(); files.dispose();
  });
});
