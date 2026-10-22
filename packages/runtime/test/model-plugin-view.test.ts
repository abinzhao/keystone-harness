import assert from "node:assert/strict";
import test from "node:test";
import { workbenchProduct } from "../../i18n/src/catalog/zh-CN/workbench-product.ts";

const PATH = "/v1/model-plugins/trae-cli";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const moduleAt = (path: string): Promise<any> => import(new URL(`../web/${path}`, import.meta.url).href);

// Same lightweight DOM and event pattern as product-workbench.test.ts.
function domFixture() {
  const document: any = { activeElement: null };
  const walk = (root: any): any[] => root.children.flatMap((child: any) => typeof child === "object" ? [child, ...walk(child)] : []);
  const matches = (entry: any, selector: string) => selector.startsWith("#")
    ? entry.id === selector.slice(1) : entry.tagName?.toLowerCase() === selector;
  const create = (tag = "div"): any => ({
    tagName: tag.toUpperCase(), children: [] as any[], attributes: {} as Record<string, string>,
    value: "", checked: false, disabled: false, handlers: {} as Record<string, any[]>,
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
      if (["id", "value"].includes(key)) this[key] = value;
      if (key === "disabled") this.disabled = true;
    },
    getAttribute(key: string) { return this.attributes[key] ?? null; },
    append(...children: any[]) { this.children.push(...children); },
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
    querySelector(selector: string) { return walk(this).find((entry) => matches(entry, selector)); },
    querySelectorAll(selector: string) { return walk(this).filter((entry) => matches(entry, selector)); },
    get textContent() { return this._text ?? this.children.map((child: any) => typeof child === "string" ? child : child.textContent ?? "").join("\n"); },
    set textContent(value: string) { this._text = String(value); this.children = []; },
  });
  document.createElement = create;
  return { document, create };
}

async function inDom(action: (f: ReturnType<typeof domFixture>) => Promise<void>, chinese = false) {
  const f = domFixture();
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ document: f.document, KEYSTONE_I18N: chinese ? workbenchProduct : {} })) {
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
function privateNetworkControl(host: any) {
  const control = host.querySelector("#trae-private-network");
  assert.ok(control, "an explicit enterprise private-network checkbox is required");
  assert.equal(control.getAttribute("type"), "checkbox");
  return control;
}

async function pluginFixture(f: ReturnType<typeof domFixture>, overrides: any = {}) {
  const { createModelPluginView } = await moduleAt("views/model-plugin.js");
  const host = f.create();
  const calls: any[] = []; const confirmations: any[] = [];
  const view = createModelPluginView(host, {
    request: async (path: string, init: any = {}) => {
      calls.push({ path, init, body: init.body ? JSON.parse(init.body) : null });
      if (path.endsWith("/discover")) return { models: [{ id: "model-a", name: "Model A" }] };
      if (path.endsWith("/probe")) return { ok: true };
      if (path.endsWith("/enable")) return { enabled: true };
      return { supported: true, ...overrides.status };
    },
    dialogs: { confirm: async (title: string, body: any) => {
      confirmations.push({ title, body });
      return true;
    } },
    ...overrides,
  });
  await settle();
  host.querySelector("#trae-endpoint").value = "api.example.com";
  host.querySelector("#trae-egress").value = "api.example.com, login.example.com";
  return { host, calls, confirmations, view };
}

async function checkModel(host: any) {
  await findButton(host, "Discover CLI models").click();
  await findButton(host, "Generation check").click();
  assert.equal(findButton(host, "Enable for new tasks").disabled, false);
}

test("private-network access is explicitly unchecked by default and status never launches checks", async () => {
  await inDom(async (f) => {
    const p = await pluginFixture(f);
    const control = privateNetworkControl(p.host);
    assert.equal(control.checked, false);
    assert.ok(p.host.querySelectorAll("label").some((label: any) => label.getAttribute("for") === control.id));
    assert.deepEqual(p.calls.map((call) => [call.path, call.init.method]), [[PATH, undefined]]);
    assert.equal(p.confirmations.length, 0);
    assert.equal(findButton(p.host, "Generation check").disabled, true);
    assert.equal(findButton(p.host, "Enable for new tasks").disabled, true);
    p.view.dispose();
  });
});

test("only literal true from plugin status restores private-network access", async () => {
  for (const value of [true, false, undefined, "true", 1]) {
    await inDom(async (f) => {
      const p = await pluginFixture(f, { status: { allowPrivateNetwork: value, generationVerified: true } });
      assert.equal(privateNetworkControl(p.host).checked, value === true);
      assert.equal(findButton(p.host, "Enable for new tasks").disabled, true);
      assert.equal(p.calls.length, 1);
      p.view.dispose();
    });
  }
});

test("status retries preserve an explicit local private-network choice", async () => {
  await inDom(async (f) => {
    const p = await pluginFixture(f, { status: { allowPrivateNetwork: true } });
    const control = privateNetworkControl(p.host);
    control.checked = false; await control.dispatch("change");
    await p.view.load();
    assert.equal(control.checked, false);
    assert.equal(p.calls.length, 2);
    assert.equal(p.calls.every((call) => call.init.method === undefined), true);
    p.view.dispose();
  });
});

test("discovery, probe and enable carry the exact private-network boolean in requests and reviews", async () => {
  for (const allowPrivateNetwork of [false, true]) {
    await inDom(async (f) => {
      const p = await pluginFixture(f);
      const control = privateNetworkControl(p.host);
      control.checked = allowPrivateNetwork; await control.dispatch("input");
      await checkModel(p.host);
      await findButton(p.host, "Enable for new tasks").click();
      assert.deepEqual(p.calls.slice(1).map((call) => call.path), ["discover", "probe", "enable"].map((kind) => `${PATH}/${kind}`));
      for (const [index, call] of p.calls.slice(1).entries()) {
        assert.equal(call.init.method, "POST");
        assert.deepEqual(call.body, {
          endpointHost: "api.example.com", egressHosts: ["api.example.com", "login.example.com"],
          allowPrivateNetwork, confirmed: true, ...(index === 0 ? {} : { modelId: "model-a" }),
        });
        const review = p.confirmations[index].body;
        assert.deepEqual(JSON.parse(review.querySelectorAll("pre")[0].textContent), call.body);
        assert.match(review.textContent, /HTTPS/);
        assert.match(review.textContent, /SNI/);
        assert.match(review.textContent, /443/);
        assert.match(review.textContent, /localhost/);
      }
      assert.equal(p.confirmations.length, 3);
      p.view.dispose();
    });
  }
});

test("Chinese checkbox guidance and reviews explain the exact DNS-host enterprise boundary", async () => {
  await inDom(async (f) => {
    const p = await pluginFixture(f);
    const control = privateNetworkControl(p.host);
    const label = p.host.querySelectorAll("label").find((entry: any) => entry.getAttribute("for") === control.id);
    assert.match(label.textContent, /企业私网/);
    const assertBoundary = (text: string) => {
      assert.match(text, /默认关闭/);
      assert.match(text, /仅.*明确.*主机/);
      assert.match(text, /DNS.*RFC1918/);
      assert.match(text, /HTTPS/);
      assert.match(text, /SNI/);
      assert.match(text, /443/);
      assert.match(text, /不.*localhost/);
      assert.match(text, /重新.*生成检查/);
      assert.doesNotMatch(text, /Allow enterprise private network|Default off/);
    };
    assertBoundary(p.host.textContent);
    control.checked = true; await control.dispatch("change");
    for (const label of ["发现 CLI 模型", "Generation check", "为新任务启用"]) await findButton(p.host, label).click();
    assert.equal(p.confirmations.length, 3);
    for (const review of p.confirmations) {
      assertBoundary(review.body.textContent);
      assert.match(review.body.textContent, /"allowPrivateNetwork": true/);
      assert.match(review.body.textContent, /api\.example\.com/);
      assert.match(review.body.textContent, /login\.example\.com/);
    }
    p.view.dispose();
  }, true);
});

test("either checkbox event invalidates discovery and generation approval even after switching back", async () => {
  for (const event of ["input", "change"]) {
    for (const original of [false, true]) {
      await inDom(async (f) => {
        const p = await pluginFixture(f, { status: { allowPrivateNetwork: original } });
        await checkModel(p.host);
        const control = privateNetworkControl(p.host);
        control.checked = !original; await control.dispatch(event);
        assert.equal(findButton(p.host, "Generation check").disabled, true);
        assert.equal(findButton(p.host, "Enable for new tasks").disabled, true);
        control.checked = original; await control.dispatch(event);
        assert.equal(findButton(p.host, "Enable for new tasks").disabled, true);
        await findButton(p.host, "Enable for new tasks").click();
        assert.equal(p.calls.some((call) => call.path.endsWith("/enable")), false);
        await checkModel(p.host);
        await findButton(p.host, "Enable for new tasks").click();
        assert.equal(p.calls.at(-1).body.allowPrivateNetwork, original);
        p.view.dispose();
      });
    }
  }
});

test("changing private-network consent cancels each pending review without launching a stale operation", async () => {
  for (const kind of ["discover", "probe", "enable"]) {
    await inDom(async (f) => {
      let answer!: (value: boolean) => void; let pending = false;
      const p = await pluginFixture(f, { dialogs: { confirm: () => pending
        ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve(true) } });
      if (kind !== "discover") await findButton(p.host, "Discover CLI models").click();
      if (kind === "enable") await findButton(p.host, "Generation check").click();
      const count = p.calls.length;
      pending = true;
      await findButton(p.host, kind === "discover" ? "Discover CLI models" : kind === "probe" ? "Generation check" : "Enable for new tasks").click();
      assert.equal(typeof answer, "function");
      const control = privateNetworkControl(p.host);
      control.checked = true; await control.dispatch("change");
      control.checked = false; await control.dispatch("change");
      answer(true); await settle();
      assert.equal(p.calls.length, count);
      assert.equal(findButton(p.host, "Enable for new tasks").disabled, true);
      assert.match(p.host.textContent, /Cancelled or configuration changed/);
      p.view.dispose();
    });
  }
});

test("a late successful generation response cannot approve edited private-network consent", async () => {
  await inDom(async (f) => {
    let finish!: (value: any) => void;
    const p = await pluginFixture(f, { request: async (path: string) => {
      if (path.endsWith("/discover")) return { models: [{ id: "model-a" }] };
      if (path.endsWith("/probe")) return new Promise((resolve) => { finish = resolve; });
      return { supported: true };
    } });
    await findButton(p.host, "Discover CLI models").click();
    await findButton(p.host, "Generation check").click();
    assert.equal(typeof finish, "function");
    const control = privateNetworkControl(p.host);
    control.checked = true; await control.dispatch("input");
    control.checked = false; await control.dispatch("input");
    finish({ ok: true }); await settle();
    assert.equal(findButton(p.host, "Enable for new tasks").disabled, true);
    p.view.dispose();
  });
});

test("declined private-network confirmation sends no request and does not silently retry", async () => {
  await inDom(async (f) => {
    let reviews = 0;
    const p = await pluginFixture(f, { dialogs: { confirm: async () => { reviews += 1; return false; } } });
    const control = privateNetworkControl(p.host);
    control.checked = true; await control.dispatch("change");
    await findButton(p.host, "Discover CLI models").click();
    assert.equal(reviews, 1);
    assert.equal(p.calls.length, 1);
    assert.equal(findButton(p.host, "Enable for new tasks").disabled, true);
    await settle();
    assert.equal(p.calls.length, 1);
    p.view.dispose();
  });
});
