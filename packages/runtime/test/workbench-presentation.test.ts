import assert from "node:assert/strict";
import test from "node:test";

const moduleAt = (path: string): Promise<any> => import(new URL(`../web/${path}`, import.meta.url).href);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const document: any = { activeElement: null };
  const walk = (root: any): any[] => root.children.flatMap((child: any) => typeof child === "object" ? [child, ...walk(child)] : []);
  const matches = (entry: any, selector: string) => selector.startsWith("#") ? entry.id === selector.slice(1)
    : selector.startsWith(".") ? entry.className?.split(" ").includes(selector.slice(1)) : entry.tagName.toLowerCase() === selector;
  const create = (tag = "div"): any => ({
    tagName: tag.toUpperCase(), children: [] as any[], attributes: {} as Record<string, string>, dataset: {}, value: "",
    disabled: false, open: false, isConnected: true, style: {}, handlers: {} as Record<string, any[]>,
    setAttribute(key: string, value: string) { this.attributes[key] = value; if (["id", "value"].includes(key)) this[key] = value; },
    getAttribute(key: string) { return this.attributes[key] ?? null; },
    removeAttribute(key: string) { delete this.attributes[key]; },
    append(...children: any[]) { this.children.push(...children); },
    prepend(...children: any[]) { this.children.unshift(...children); },
    replaceChildren(...children: any[]) { this.children = children; this._text = undefined; },
    addEventListener(kind: string, fn: any) { (this.handlers[kind] ??= []).push(fn); },
    async dispatch(kind: string) {
      const event = { currentTarget: this, target: this, preventDefault() {} };
      await this[`on${kind}`]?.(event);
      for (const fn of this.handlers[kind] ?? []) await fn(event);
      await settle();
    },
    click() { if (!this.disabled) return this.dispatch("click"); },
    focus() { document.activeElement = this; },
    showModal() { this.open = true; },
    close() { this.open = false; setImmediate(() => this.handlers.close?.forEach((fn: any) => fn({}))); },
    querySelector(selector: string) { return walk(this).find((entry) => matches(entry, selector)); },
    querySelectorAll(selector: string) { return walk(this).filter((entry) => matches(entry, selector)); },
    get textContent() { return this._text ?? this.children.map((child: any) => typeof child === "string" ? child : child.textContent ?? "").join("\n"); },
    set textContent(value: string) { this._text = value; },
  });
  document.createElement = create;
  document.getElementById = () => null;
  return { document, create, walk };
}

async function inDom(action: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = f.document;
  try { await action(f); } finally { globals.document = original; }
}

test("settings modal preserves the background view and rejects unconfirmed dirty dismissal", async () => {
  const { createSettingsModal } = await moduleAt("components/settings-modal.js");
  await inDom(async (f) => {
    const dialog = f.create("dialog"); const host = f.create(); const closeButton = f.create("button");
    const opener = f.create("button"); opener.focus();
    let dirty = false; let accept = false; let disposed = 0; let discarded = 0; let mounts = 0;
    const modal = createSettingsModal({
      dialog, host, closeButton, dialogs: { confirm: async () => accept },
      createView: () => { mounts += 1; return { get dirty() { return dirty; }, dispose() { disposed += 1; } }; },
      onDiscard: () => { discarded += 1; },
    });
    modal.open(); modal.open();
    assert.equal(mounts, 1);
    dirty = true;
    assert.equal(await modal.close(), false);
    assert.equal(dialog.open, true); assert.equal(disposed, 0);
    accept = true; assert.equal(await modal.close(), true);
    assert.equal(disposed, 1); assert.equal(discarded, 1); assert.equal(f.document.activeElement, opener);
    modal.open(); await settle();
    assert.equal(dialog.open, true, "queued native close cannot dispose the reopened settings view");
    assert.equal(disposed, 1);
    modal.dispose();
  });
});

test("settings modal cannot discard a revision while the save request is in flight", async () => {
  const { createSettingsModal } = await moduleAt("components/settings-modal.js");
  await inDom(async (f) => {
    const dialog = f.create("dialog"); const host = f.create(); const closeButton = f.create("button");
    let saving = true; let confirmations = 0; let disposed = 0;
    const modal = createSettingsModal({
      dialog, host, closeButton,
      dialogs: { confirm: async () => { confirmations += 1; return true; } },
      createView: () => ({ dirty: true, get saving() { return saving; }, dispose() { disposed += 1; } }),
      onDiscard() {},
    });
    modal.open(); assert.equal(await modal.close(), false);
    assert.equal(confirmations, 0); assert.equal(disposed, 0);
    saving = false; assert.equal(await modal.close(), true);
    assert.equal(confirmations, 1); assert.equal(disposed, 1);
    modal.dispose();
  });
});

test("theme tiles preview one draft, retain row controls and save the selected theme", async () => {
  const { createSettingsView } = await moduleAt("views/settings.js");
  await inDom(async (f) => {
    const host = f.create(); const previews: any[] = []; const writes: any[] = [];
    const initial = { revision: "r1", config: { models: [], language: "en" }, presentation: { theme: "system", density: "comfortable" } };
    const view = createSettingsView(host, {
      request: async (_path: string, init: any = {}) => {
        if (!init.method) return initial;
        const body = JSON.parse(init.body); writes.push(body);
        return { ...initial, revision: "r2", ...body, config: body.config, presentation: body.presentation };
      },
      dialogs: {}, state: {}, capabilities: {}, onSaved() {}, onPresentation: (value: any) => previews.push({ ...value }),
    });
    await settle();
    const tiles = host.querySelector(".theme-tiles"); assert.ok(tiles);
    const dark = tiles.querySelectorAll("button").find((entry: any) => entry.getAttribute("data-theme-choice") === "dark");
    assert.ok(dark); await dark.click();
    assert.equal(view.dirty, true); assert.equal(previews.at(-1).theme, "dark");
    assert.equal(dark.getAttribute("aria-pressed"), "true");
    assert.ok(host.querySelector("#settings-language"));
    assert.ok(host.querySelector("#settings-density"));
    await f.walk(host).find((entry) => entry.tagName === "BUTTON" && entry.textContent === "Save and apply").click();
    assert.equal(writes[0].presentation.theme, "dark"); assert.equal(view.dirty, false);
    view.dispose();
  });
});

test("delivery claims reject invalidated, disconnected, cross-task and corrupt-ledger proof", async () => {
  const { proofIsCurrent } = await moduleAt("views/task.js");
  const state = { taskId: "task", connection: "connected", proof: { taskId: "task", outcome: "proven" }, detail: { ledger: { integrityOk: true } } };
  assert.equal(proofIsCurrent(state), true);
  assert.equal(proofIsCurrent({ ...state, connection: "stale" }), false);
  assert.equal(proofIsCurrent({ ...state, detail: { proofInvalidated: { reason: "Workspace changed" } } }), false);
  assert.equal(proofIsCurrent({ ...state, proof: { taskId: "other", outcome: "proven" } }), false);
  assert.equal(proofIsCurrent({ ...state, detail: { ledger: { integrityOk: false } } }), false);
});

test("proof page follows condition to evidence to original observation without elevating stale verdicts", async () => {
  const { renderProofView } = await moduleAt("views/task.js");
  assert.equal(typeof renderProofView, "function");
  await inDom(async (f) => {
    const host = f.create();
    const state = {
      connection: "stale", taskId: "t", detail: {
        contract: { completionConditions: [{ conditionId: "test", description: "Tests pass", required: true }] },
        evidence: [{ evidenceId: "ev", summary: "Two tests", level: "L2", producer: "node:test", status: "valid" }],
      },
      proof: { taskId: "t", outcome: "proven", conditions: [{ conditionId: "test", satisfied: true, evidenceIds: ["ev"] }], residualRisks: ["No provider test"] },
      events: [{ type: "evidence.recorded", payload: { evidenceId: "ev", observation: { exitCode: 0 }, provenance: { source: "artifact/output", trust: "tool_observation" } } }],
    };
    renderProofView(host, state);
    assert.match(host.textContent, /Tests pass/); assert.match(host.textContent, /Two tests/);
    assert.match(host.textContent, /artifact\/output/); assert.match(host.textContent, /exitCode/);
    assert.match(host.textContent, /Stale/); assert.match(host.textContent, /No provider test/);
    assert.doesNotMatch(host.textContent, /Safe to deliver/);
  });
});
