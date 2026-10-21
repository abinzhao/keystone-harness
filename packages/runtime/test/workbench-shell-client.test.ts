import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Minimal DOM fixture for the real module bootstrap; layout belongs to browser QA.
function shellDom(html: string) {
  const document: any = { activeElement: null, hidden: false, handlers: {} };
  const walk = (root: any): any[] => root.children.flatMap((child: any) => typeof child === "object" ? [child, ...walk(child)] : []);
  const matches = (entry: any, selector: string) => selector.split(",").some((part) => {
    const value = part.trim();
    if (value.startsWith("#")) return entry.id === value.slice(1);
    if (value.startsWith("[")) return entry.getAttribute?.(value.slice(1, -1)) != null;
    return entry.tagName?.toLowerCase() === value;
  });
  const create = (tag = "div"): any => {
    const entry: any = {
      tagName: tag.toUpperCase(), children: [], attributes: {}, dataset: {}, parentElement: null,
      _value: "", disabled: false, hidden: false, open: false, inert: false, isConnected: true, handlers: {},
      style: { setProperty(key: string, value: string) { this[key as keyof typeof this] = value as any; } },
      setAttribute(key: string, value: string) {
        this.attributes[key] = value;
        if (key === "id") this.id = value;
        if (key === "class") this.className = value;
        if (key === "value") this._value = value;
        if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_match: string, letter: string) => letter.toUpperCase())] = value;
        if (["hidden", "disabled", "selected"].includes(key)) this[key] = true;
      },
      getAttribute(key: string) { return this.attributes[key] ?? null; },
      removeAttribute(key: string) { delete this.attributes[key]; },
      detach(child: any) {
        if (typeof child !== "object") return;
        if (child.parentElement) child.parentElement.children = child.parentElement.children.filter((item: any) => item !== child);
        child.parentElement = this;
      },
      append(...children: any[]) { for (const child of children) { this.detach(child); this.children.push(child); } },
      prepend(...children: any[]) { for (const child of children) this.detach(child); this.children.unshift(...children); },
      replaceChildren(...children: any[]) { for (const child of this.children) if (typeof child === "object") child.parentElement = null; this.children = []; this.append(...children); },
      addEventListener(kind: string, handler: any) { (this.handlers[kind] ??= []).push(handler); },
      async dispatch(kind: string, values = {}) {
        const event = { currentTarget: this, target: this, preventDefault() {}, ...values };
        await this[`on${kind}`]?.(event);
        for (const handler of this.handlers[kind] ?? []) await handler(event);
        await settle();
      },
      click() { if (!this.disabled) return this.dispatch("click"); },
      focus() { document.activeElement = this; },
      contains(child: any) { return this === child || walk(this).includes(child); },
      querySelector(selector: string) { return walk(this).find((child) => matches(child, selector)) ?? null; },
      querySelectorAll(selector: string) { return walk(this).filter((child) => matches(child, selector)); },
      showModal() { this.open = true; },
      close() { this.open = false; },
      scrollIntoView() {},
      get firstChild() { return this.children[0]; },
      get lastChild() { return this.children.at(-1); },
      get options() { return this.children; },
      get value() {
        return this.tagName === "SELECT" && !this._value ? this.children.find((child: any) => child.selected)?.value ?? this.children[0]?.value ?? "" : this._value;
      },
      set value(value: string) { this._value = value; },
      get textContent() { return this.children.map((child: any) => typeof child === "string" ? child : child.textContent ?? "").join(""); },
      set textContent(value: string) { this.replaceChildren({ tagName: "#TEXT", children: [], textContent: String(value), isConnected: true }); },
    };
    entry.classList = {
      contains: (value: string) => (entry.className ?? "").split(" ").includes(value),
      toggle(value: string, force?: boolean) {
        const classes = new Set<string>((entry.className ?? "").split(" ").filter(Boolean));
        const enabled = force ?? !classes.has(value);
        if (enabled) classes.add(value); else classes.delete(value);
        entry.className = [...classes].join(" "); return enabled;
      },
      add(value: string) { this.toggle(value, true); },
      remove(value: string) { this.toggle(value, false); },
    };
    return entry;
  };
  const root = create("document");
  const stack = [root];
  const voidTags = new Set(["meta", "link", "input", "img", "br"]);
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g)) {
    const value = token[0];
    if (value.startsWith("<!")) continue;
    if (value.startsWith("</")) { stack.pop(); continue; }
    if (value.startsWith("<")) {
      const tag = /^<([a-z][a-z0-9-]*)/i.exec(value)?.[1];
      if (!tag) continue;
      const entry = create(tag);
      for (const attr of value.slice(tag.length + 1, -1).matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/gi)) entry.setAttribute(attr[1]!, attr[2] ?? "");
      stack.at(-1)!.append(entry);
      if (!voidTags.has(tag) && !value.endsWith("/>")) stack.push(entry);
    } else {
      const text: any = { tagName: "#TEXT", children: [], textContent: value, isConnected: true };
      stack.at(-1)!.append(text);
    }
  }
  document.createElement = create;
  document.createElementNS = (namespace: string, tag: string) => Object.assign(create(tag), { namespaceURI: namespace });
  document.documentElement = root.querySelector("html");
  document.getElementById = (id: string) => root.querySelector(`#${id}`);
  document.querySelectorAll = (selector: string) => root.querySelectorAll(selector);
  document.addEventListener = (kind: string, fn: any) => { (document.handlers[kind] ??= []).push(fn); };
  return { document, root, walk };
}

test("real shell bootstraps and routes the welcome, task, settings and service pages", async () => {
  const html = await readFile(new URL("../web/workbench.html", import.meta.url), "utf8");
  const f = shellDom(html);
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: any) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const calls: { path: string; init: any }[] = [];
  const handlers: Record<string, any[]> = {};
  const settings = { revision: "r1", config: { models: [], language: "en" }, presentation: { theme: "light", density: "comfortable" } };
  setGlobal("document", f.document);
  setGlobal("location", { hash: "#t=fixture-only" });
  setGlobal("navigator", { onLine: true });
  setGlobal("window", { addEventListener: (kind: string, handler: any) => { (handlers[kind] ??= []).push(handler); } });
  setGlobal("matchMedia", () => ({ matches: false }));
  setGlobal("localStorage", { getItem() { return null; }, setItem() {}, removeItem() {} });
  setGlobal("setInterval", () => 0); setGlobal("clearInterval", () => {});
  setGlobal("KEYSTONE_LANG", "en"); setGlobal("KEYSTONE_I18N", {});
  setGlobal("fetch", async (path: string, init: any) => {
    calls.push({ path, init });
    const data = path === "/v1/projects" ? { projects: [{ projectId: "p", name: "Keystone", rootPath: "/fixture", branch: "main" }] }
      : path === "/v1/tasks" ? { tasks: [{ projectId: "p", taskId: "t", title: "Audit lease boundaries", status: "paused" }] }
      : path === "/v1/settings" ? settings : path === "/v1/capabilities" ? { egress: [] }
      : path === "/v1/tasks/t" ? { taskId: "t", status: "paused", contract: { goal: "Audit lease boundaries", completionConditions: [] } }
      : path === "/v1/tasks/t/events?since=0" ? { events: [] }
      : path === "/v1/tasks/t/checkpoints" ? { checkpoints: [] }
      : path === "/v1/tasks/t/run" ? { taskId: "t", status: "paused" }
      : path === "/v1/tasks/t/proof" ? { taskId: "t", outcome: "unproven", conditions: [] }
      : path.startsWith("/v1/projects/p/files?") ? { entries: [], nextOffset: null }
      : path === "/v1/tasks/t/branches" ? { branches: [] }
      : path === "/v1/tasks/t/diff" ? { diff: "", changedPaths: [] }
      : path === "/v1/extensions" ? { extensions: [] }
      : path === "/v1/projects/p/cognition" ? { facts: [], experience: [] }
      : path === "/v1/lab" ? { reports: [] }
      : path === "/v1/collaboration" ? { signatures: [], imports: [], delegations: [], shared: [] }
      : path === "/v1/release/readiness" ? { gates: [{ name: "Provider verification", status: "missing" }] } : {};
    return { ok: path !== "/desktop/bootstrap", status: path === "/desktop/bootstrap" ? 404 : 200, json: async () => data };
  });
  const id = (value: string) => f.document.getElementById(value);
  try {
    await import(new URL("../web/client/main.js", import.meta.url).href);
    await settle();
    assert.equal(id("composer-host").parentElement, id("welcome-composer"));
    assert.equal(id("app").classList.contains("welcome"), true);
    assert.equal(id("inspector").inert, true);
    assert.equal(id("connection").textContent, "Connected locally");
    assert.equal(id("error").hidden, true);
    const task = f.walk(id("project-list")).find((entry) => entry.tagName === "BUTTON" && entry.textContent.includes("Audit lease boundaries"));
    assert.ok(task); task.focus();
    for (const handler of f.document.handlers.visibilitychange ?? []) handler();
    await settle(); await settle();
    assert.equal(f.walk(id("project-list")).includes(task), true, "unchanged polling must retain the focused navigation element");
    await task.click(); await settle();
    assert.equal(id("task-title").textContent, "Audit lease boundaries");
    assert.equal(id("composer-host").parentElement, id("task-composer"));
    assert.equal(id("welcome").hidden, true);
    for (const [view, path] of [
      ["files", "/v1/projects/p/files?"], ["commands", null], ["proof", null],
      ["recovery", "/v1/tasks/t/branches"], ["diff", "/v1/tasks/t/diff"], ["trace", null], ["overview", null],
    ] as const) {
      await id("workspace-tabs").querySelectorAll("button").find((entry: any) => entry.dataset.view === view).click();
      if (path) assert.ok(calls.some((entry) => entry.path.startsWith(path)), path);
      assert.equal(id("view-host").hidden, false);
    }
    const background = id("view-host").firstChild;
    await id("settings-button").click();
    assert.equal(id("settings-modal").open, true);
    assert.equal(id("view-host").firstChild, background);
    assert.ok(id("settings-host").querySelector("#settings-language"));
    await id("settings-close").click();
    assert.equal(id("settings-modal").open, false);
    for (const [page, path] of [
      ["extensions", "/v1/extensions"], ["cognition", "/v1/projects/p/cognition"],
      ["lab", "/v1/lab"], ["collaboration", "/v1/collaboration"], ["readiness", "/v1/release/readiness"],
    ]) {
      await f.document.querySelectorAll("[data-page]").find((entry: any) => entry.dataset.page === page).click();
      assert.ok(calls.some((entry) => entry.path === path), path);
      assert.equal(id("workspace-footer").hidden, true);
    }
    assert.match(id("view-host").textContent, /Provider verification/);
    await id("new-task").click();
    assert.equal(id("composer-host").parentElement, id("welcome-composer"));
    assert.equal(f.document.activeElement.id, "composer-input");
    assert.equal(calls.filter((entry) => ["POST", "PATCH", "DELETE"].includes(entry.init?.method)).length, 0);
  } finally {
    for (const handler of handlers.pagehide ?? []) handler();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
