import assert from "node:assert/strict";
import test from "node:test";

const moduleAt = (path: string): Promise<any> => import(new URL(`../web/${path}`, import.meta.url).href).catch(() => ({}));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function dom() {
  const document: any = { activeElement: null };
  const walk = (root: any): any[] => root.children.flatMap((child: any) => typeof child === "object" ? [child, ...walk(child)] : []);
  const matches = (entry: any, selector: string): boolean => selector.split(",").some((part) => {
    const value = part.trim();
    if (value.startsWith("#")) return entry.id === value.slice(1);
    if (value.startsWith(".")) return entry.className?.split(" ").includes(value.slice(1));
    return entry.tagName?.toLowerCase() === value;
  });
  const create = (tag = "div"): any => ({
    tagName: tag.toUpperCase(), children: [] as any[], attributes: {} as Record<string, string>, dataset: {}, value: "", disabled: false, hidden: false,
    handlers: {} as Record<string, ((event: any) => any)[]>, style: {}, isConnected: true,
    setAttribute(key: string, value: string) { this.attributes[key] = value; if (key === "id" || key === "value") this[key] = value; },
    removeAttribute(key: string) { delete this.attributes[key]; },
    getAttribute(key: string) { return this.attributes[key] ?? null; },
    append(...children: any[]) { this.children.push(...children); },
    prepend(...children: any[]) { this.children.unshift(...children); },
    replaceChildren(...children: any[]) { this.children = children; this._text = undefined; },
    addEventListener(kind: string, fn: any) { (this.handlers[kind] ??= []).push(fn); },
    async dispatch(kind: string) {
      const event = { currentTarget: this, target: this, preventDefault() {} };
      await this[`on${kind}`]?.(event);
      for (const handler of this.handlers[kind] ?? []) await handler(event);
      await settle();
    },
    click() { if (!this.disabled) return this.dispatch("click"); },
    focus() { document.activeElement = this; },
    querySelector(selector: string) { return walk(this).find((entry) => matches(entry, selector)); },
    querySelectorAll(selector: string) { return walk(this).filter((entry) => matches(entry, selector)); },
    get textContent() { return this._text ?? this.children.map((entry: any) => typeof entry === "string" ? entry : entry.textContent ?? "").join("\n"); },
    set textContent(value: string) { this._text = value; },
  });
  document.createElement = create; document.getElementById = () => null;
  const host = create();
  return {
    document, host, walk,
    button(label: string) {
      const result = walk(host).find((entry) => entry.tagName === "BUTTON" && entry.textContent === label);
      assert.ok(result, `Missing action: ${label}`);
      return result;
    },
  };
}

async function inDom(action: (fixture: ReturnType<typeof dom>) => Promise<void>) {
  const fixture = dom();
  const globals = globalThis as typeof globalThis & { document?: any };
  const original = globals.document; globals.document = fixture.document;
  try { await action(fixture); } finally { globals.document = original; }
}

test("service resources reject late reads and retain known data as stale, never empty success", async () => {
  const { createResource } = await moduleAt("state/resource.js");
  assert.equal(typeof createResource, "function");
  const pending: any[] = [];
  const resource = createResource({ path: "/v1/extensions", request: (_path: string, init: any) => new Promise((resolve, reject) => pending.push({ resolve, reject, init })) });
  const first = resource.load(); const second = resource.load();
  assert.equal(pending[0].init.signal.aborted, true);
  pending[1].resolve({ extensions: [{ name: "new" }] }); await second;
  pending[0].resolve({ extensions: [{ name: "old" }] }); await first;
  assert.equal(resource.state.data.extensions[0].name, "new");
  const failed = resource.load(); pending[2].reject(Object.assign(new Error("Not implemented"), { status: 501 })); await failed;
  assert.equal(resource.state.data.extensions[0].name, "new");
  assert.equal(resource.state.stale, true);
  assert.equal(resource.state.error.status, 501);
  resource.dispose();
});

test("service mutations serialize and refresh from the server without optimistic authoritative edits", async () => {
  const { createResource } = await moduleAt("state/resource.js");
  assert.equal(typeof createResource, "function");
  let release!: (value: any) => void;
  const calls: any[] = [];
  const resource = createResource({ path: "/v1/lab", request: async (path: string, init: any = {}) => {
    calls.push({ path, init });
    if (init.method === "POST") return new Promise((resolve) => { release = resolve; });
    return { reports: [] };
  } });
  await resource.load();
  const mutation = resource.mutate("/v1/lab", { method: "POST", body: '{"directory":"/fixture"}' });
  assert.equal(resource.state.busy, true);
  await resource.mutate("/v1/lab", { method: "POST", body: "{}" });
  assert.equal(calls.length, 2, "double-click must not duplicate side effects");
  assert.deepEqual(resource.state.data, { reports: [] });
  release({ report: { status: "failed" } }); await mutation;
  assert.equal(calls.length, 3);
  assert.equal(resource.state.result.report.status, "failed");
  resource.dispose();
});

test("cognition renders provenance and submits correction with the observed fact hash", async () => {
  const { createCognitionView } = await moduleAt("views/cognition.js");
  assert.equal(typeof createCognitionView, "function");
  await inDom(async (f) => {
    const calls: any[] = []; let confirmed = false;
    const projection = { facts: [{ factId: "fact/a", statement: "Uses Node", hash: "sha256:fact", updatedAt: "2026-10-21T00:00:00Z", scope: ["src/**"], provenance: { source: "AGENTS.md", trust: "user_confirmed" }, dependencies: ["package.json"] }], experience: [] };
    const view = createCognitionView(f.host, {
      projectId: "proj/a",
      request: async (path: string, init: any = {}) => { calls.push({ path, init }); return projection; },
      dialogs: { prompt: async () => "Uses native Node ESM", confirm: async () => confirmed },
    });
    await settle();
    assert.match(f.host.textContent, /AGENTS\.md/); assert.match(f.host.textContent, /package\.json/);
    await f.button("Correct fact").click();
    assert.equal(calls.filter((entry) => entry.init.method === "PATCH").length, 0);
    confirmed = true; await f.button("Correct fact").click();
    const patched = calls.find((entry) => entry.init.method === "PATCH");
    assert.equal(patched.path, "/v1/projects/proj%2Fa/facts/fact%2Fa");
    assert.deepEqual(JSON.parse(patched.init.body), { expectedHash: "sha256:fact", statement: "Uses native Node ESM" });
    view.dispose();
  });
});

test("fact freeze and experience confirmation/revocation require explicit user intent", async () => {
  const { createCognitionView } = await moduleAt("views/cognition.js");
  assert.equal(typeof createCognitionView, "function");
  await inDom(async (f) => {
    const calls: any[] = [];
    const view = createCognitionView(f.host, {
      projectId: "p",
      request: async (path: string, init: any = {}) => {
        calls.push({ path, init });
        return { facts: [{ factId: "f", statement: "Frozen rule", frozen: true, hash: "sha256:f" }],
          experience: { entries: [], candidates: [{ entryId: "e", statement: "Candidate", status: "candidate", provenance: { trust: "untrusted" } }] } };
      },
      dialogs: { confirm: async () => true, prompt: async () => "Reviewed locally" },
    });
    await settle(); await f.button("Unfreeze fact").click(); await f.button("Confirm experience").click(); await f.button("Revoke experience").click();
    const mutations = calls.filter((entry) => entry.init.method);
    // An untrusted or malformed candidate cannot be confirmed, and revocation
    // addresses promoted entries only; these are the server's actual rules.
    assert.deepEqual(mutations.map((entry) => JSON.parse(entry.init.body)), [
      { expectedHash: "sha256:f", frozen: false },
    ]);
    view.dispose();
  });
});

test("facts without concurrency hashes remain read-only and correction conflicts are visible", async () => {
  const { createCognitionView } = await moduleAt("views/cognition.js");
  await inDom(async (f) => {
    let withHash = false; let writes = 0;
    const view = createCognitionView(f.host, {
      projectId: "p", dialogs: { prompt: async () => "Correction", confirm: async () => true },
      request: async (_path: string, init: any = {}) => {
        if (init.method === "PATCH") { writes += 1; throw Object.assign(new Error("Fact changed; reload"), { status: 409, body: { currentHash: "new" } }); }
        return { facts: [{ factId: "f", statement: "Known fact", ...(withHash ? { hash: "original" } : {}) }], experience: [] };
      },
    });
    await settle();
    assert.equal(f.button("Correct fact").disabled, true); assert.equal(f.button("Freeze fact").disabled, true);
    withHash = true; await f.button("Refresh").click(); await f.button("Correct fact").click();
    assert.equal(writes, 1); assert.match(f.host.textContent, /Fact changed; reload/); assert.match(f.host.textContent, /Known fact/);
    view.dispose();
  });
});

test("cognition exposes source/scope metadata and addresses quarantined candidates by candidateId", async () => {
  const { createCognitionView } = await moduleAt("views/cognition.js");
  await inDom(async (f) => {
    const calls: any[] = [];
    const view = createCognitionView(f.host, {
      projectId: "p", dialogs: { confirm: async () => true },
      request: async (path: string, init: any = {}) => {
        calls.push({ path, init });
        return {
          facts: [{ factId: "f", hash: "h", statement: "Scoped rule", subjects: ["packages/runtime/**"], source: { locator: "AGENTS.md", trustLevel: "user_confirmed" }, derivedFrom: ["fact_origin"] }],
          experience: { candidates: [{ candidateId: "candidate/a", statement: "Quarantined", status: "quarantined" }], entries: [] },
        };
      },
    });
    await settle();
    assert.ok(f.host.querySelector(".projection-metadata"), "source metadata must be visible without opening raw JSON");
    await f.button("Confirm experience").click();
    assert.ok(calls.some((entry) => entry.path === "/v1/projects/p/experience/candidate%2Fa" && entry.init.method === "POST"));
    view.dispose();
  });
});

test("extensions install only the unchanged directory's reviewed hash after confirmation", async () => {
  const { createExtensionsView } = await moduleAt("views/extensions.js");
  assert.equal(typeof createExtensionsView, "function");
  await inDom(async (f) => {
    const calls: any[] = []; let accept = false;
    const view = createExtensionsView(f.host, {
      request: async (path: string, init: any = {}) => {
        calls.push({ path, init });
        if (path.endsWith("/review")) return { reviewHash: "sha256:review", manifest: { name: "fixture", version: "1.0.0", requestedCapabilities: ["fs.read"] } };
        return { extensions: [] };
      },
      dialogs: { confirm: async () => accept },
    });
    await settle();
    const directory = f.host.querySelector("#extension-directory");
    directory.value = "/fixture"; await directory.dispatch("input");
    await f.button("Review directory").click();
    await f.button("Install reviewed extension").click();
    assert.equal(calls.filter((entry) => entry.path.endsWith("/install")).length, 0);
    accept = true; await f.button("Install reviewed extension").click();
    assert.deepEqual(JSON.parse(calls.find((entry) => entry.path.endsWith("/install")).init.body),
      { directory: "/fixture", reviewHash: "sha256:review", confirmed: true });
    directory.value = "/other"; await directory.dispatch("input");
    assert.equal(f.button("Install reviewed extension").disabled, true);
    view.dispose();
  });
});

test("missing review hashes cannot enable installation and installed actions call real endpoints", async () => {
  const { createExtensionsView } = await moduleAt("views/extensions.js");
  assert.equal(typeof createExtensionsView, "function");
  await inDom(async (f) => {
    const calls: any[] = [];
    const view = createExtensionsView(f.host, {
      request: async (path: string, init: any = {}) => {
        calls.push({ path, init });
        return path.endsWith("/review") ? { manifest: { name: "fixture" } }
          : { installed: [{ manifest: { name: "fixture/one", version: "1" }, reviewHash: "installed-hash", status: "disabled" }], discovery: [] };
      },
      dialogs: { confirm: async () => true },
    });
    await settle();
    f.host.querySelector("#extension-directory").value = "/fixture";
    await f.button("Review directory").click();
    assert.equal(f.button("Install reviewed extension").disabled, true);
    await f.button("Probe").click(); await f.button("Activate").click(); await f.button("Disable").click(); await f.button("Uninstall").click();
    assert.deepEqual(calls.filter((entry) => /fixture%2Fone/.test(entry.path)).map((entry) => entry.path.split("/").at(-1)),
      ["probe", "activate", "disable", "uninstall"]);
    assert.deepEqual(calls.filter((entry) => /fixture%2Fone\/(?:probe|activate)$/.test(entry.path)).map((entry) => JSON.parse(entry.init.body)),
      [{ reviewHash: "installed-hash", confirmed: true }, { reviewHash: "installed-hash", confirmed: true }]);
    assert.deepEqual(calls.filter((entry) => /fixture%2Fone\/(?:disable|uninstall)$/.test(entry.path)).map((entry) => JSON.parse(entry.init.body)),
      [{ reviewHash: "installed-hash", confirmed: true }, { reviewHash: "installed-hash", confirmed: true }]);
    view.dispose();
  });
});

test("extension static blockers disable installation and upgrade permission changes stay visible", async () => {
  const { createExtensionsView } = await moduleAt("views/extensions.js");
  await inDom(async (f) => {
    const view = createExtensionsView(f.host, {
      request: async (path: string) => path.endsWith("/review") ? {
        reviewHash: "review", blockers: ["dependency.missing"], read: { manifest: { name: "fixture", version: "2" } },
        upgrade: { fromVersion: "1", toVersion: "2", changedFiles: ["entry.js"], addedCapabilities: ["network.http"], permissionsChanged: true },
      } : { extensions: [] },
      dialogs: {},
    });
    await settle(); f.host.querySelector("#extension-directory").value = "/fixture";
    await f.button("Review directory").click();
    assert.equal(f.button("Install reviewed extension").disabled, true);
    assert.ok(f.host.querySelector(".upgrade-summary"));
    assert.match(f.host.textContent, /network\.http/); assert.match(f.host.textContent, /dependency\.missing/);
    view.dispose();
  });
});

test("unhashed installed extensions cannot probe or activate an unspecified version", async () => {
  const { createExtensionsView } = await moduleAt("views/extensions.js");
  await inDom(async (f) => {
    const view = createExtensionsView(f.host, {
      request: async () => ({ extensions: [{ manifest: { name: "fixture" }, status: "registered" }] }), dialogs: {},
    });
    await settle();
    assert.equal(f.button("Probe").disabled, true); assert.equal(f.button("Activate").disabled, true);
    assert.match(f.host.textContent, /review hash/i);
    view.dispose();
  });
});

test("Lab reports real failures and confirms the isolated directory before running", async () => {
  const { createLabView } = await moduleAt("views/lab.js");
  assert.equal(typeof createLabView, "function");
  await inDom(async (f) => {
    const calls: any[] = []; let confirmed = false;
    const view = createLabView(f.host, {
      request: async (path: string, init: any = {}) => {
        calls.push({ path, init });
        if (path === "/v1/extensions/review") return { reviewHash: "lab-hash", read: { manifest: { name: "fixture" } }, blockers: [] };
        return init.method ? { report: { status: "failed", isolation: "temporary workspace", failures: ["Denied capability"] } }
          : { reports: [{ reportId: "actual", status: "failed", failures: ["Denied capability"] }] };
      },
      dialogs: { confirm: async () => confirmed },
    });
    await settle(); assert.match(f.host.textContent, /Denied capability/);
    f.host.querySelector("#lab-directory").value = "/fixture";
    await f.button("Run isolated checks").click(); assert.equal(calls.filter((entry) => entry.path === "/v1/lab" && entry.init.method).length, 0);
    confirmed = true; await f.button("Run isolated checks").click();
    assert.deepEqual(JSON.parse(calls.find((entry) => entry.path === "/v1/lab" && entry.init.method).init.body),
      { directory: "/fixture", reviewHash: "lab-hash", confirmed: true });
    assert.match(f.host.textContent, /failed/);
    view.dispose();
  });
});

test("a completed Lab request remains inspectable when report listing cannot be refreshed", async () => {
  const { createLabView } = await moduleAt("views/lab.js");
  await inDom(async (f) => {
    const view = createLabView(f.host, {
      request: async (path: string, init: any = {}) => {
        if (path === "/v1/extensions/review") return { reviewHash: "lab-hash" };
        if (init.method) return { report: { status: "failed", failures: ["Missing independence"] } };
        throw Object.assign(new Error("Report listing unavailable"), { status: 501 });
      },
      dialogs: { confirm: async () => true },
    });
    await settle();
    f.host.querySelector("#lab-directory").value = "/fixture";
    await f.button("Run isolated checks").click();
    assert.match(f.host.textContent, /Missing independence/);
    assert.match(f.host.textContent, /Report listing unavailable/);
    view.dispose();
  });
});

test("Lab refuses execution when static review cannot provide a usable unblocked hash", async () => {
  const { createLabView } = await moduleAt("views/lab.js");
  await inDom(async (f) => {
    let runs = 0;
    const view = createLabView(f.host, {
      request: async (path: string, init: any = {}) => {
        if (path === "/v1/extensions/review") return { reviewHash: "hash", blockers: ["unsafe"] };
        if (init.method) runs += 1;
        return { reports: [] };
      }, dialogs: { confirm: async () => true },
    });
    await settle(); f.host.querySelector("#lab-directory").value = "/fixture";
    await f.button("Run isolated checks").click();
    assert.equal(runs, 0); assert.match(f.host.textContent, /unavailable|blocked/i);
    view.dispose();
  });
});

test("recovery uses checkpoint/label and explicit branch comparison query, not local state edits", async () => {
  const { createRecoveryView } = await moduleAt("views/recovery.js");
  assert.equal(typeof createRecoveryView, "function");
  await inDom(async (f) => {
    const calls: any[] = []; let refreshed = 0;
    const view = createRecoveryView(f.host, {
      taskId: "task/a", checkpoints: [{ checkpointId: "cp/a", reason: "user_requested" }],
      request: async (path: string, init: any = {}) => {
        calls.push({ path, init });
        return path.includes("/compare?") ? { left: "base", right: "candidate", proof: { outcome: "unproven" } }
          : { branches: [{ branchId: "base", label: "primary", status: "paused" }, { branchId: "candidate", label: "Candidate" }] };
      },
      dialogs: { confirm: async () => true }, refresh: async () => { refreshed += 1; },
    });
    await settle();
    await f.button("Resume task").click();
    f.host.querySelector("#branch-checkpoint").value = "cp/a"; f.host.querySelector("#branch-label").value = "Try smaller scope";
    await f.button("Create branch").click();
    assert.deepEqual(JSON.parse(calls.find((entry) => entry.init.method && entry.path.endsWith("/branches")).init.body),
      { checkpointId: "cp/a", label: "Try smaller scope" });
    f.host.querySelector("#compare-left").value = "base"; f.host.querySelector("#compare-right").value = "candidate";
    await f.button("Compare branches").click();
    assert.ok(calls.some((entry) => entry.path === "/v1/tasks/task%2Fa/compare?left=base&right=candidate"));
    assert.ok(calls.some((entry) => entry.path === "/v1/tasks/task%2Fa/resume" && entry.init.method === "POST"));
    assert.ok(refreshed >= 1); assert.match(f.host.textContent, /unproven/);
    view.dispose();
  });
});

test("recovery receives new checkpoints without resetting the branch-label draft", async () => {
  const { createRecoveryView } = await moduleAt("views/recovery.js");
  await inDom(async (f) => {
    const view = createRecoveryView(f.host, { taskId: "t", checkpoints: [], request: async () => ({ branches: [] }), dialogs: {} });
    await settle(); assert.equal(f.button("Create branch").disabled, true);
    f.host.querySelector("#branch-label").value = "Keep this draft";
    assert.equal(typeof view.update, "function");
    view.update([{ checkpointId: "new", reason: "user_requested" }]);
    assert.equal(f.host.querySelector("#branch-label").value, "Keep this draft");
    assert.ok(f.host.querySelector("#branch-checkpoint").querySelectorAll("option").some((entry: any) => entry.value === "new"));
    assert.equal(f.button("Create branch").disabled, false);
    view.dispose();
  });
});

test("recovery refuses resume controls for unresolved attention and unknown status", async () => {
  const { createRecoveryView } = await moduleAt("views/recovery.js");
  for (const status of ["needs_attention", undefined]) await inDom(async (f) => {
    let writes = 0;
    const view = createRecoveryView(f.host, {
      taskId: "attention", checkpoints: [], dialogs: { confirm: async () => true },
      request: async (_path: string, init: any = {}) => {
        if (init.method === "POST") writes++;
        return { branches: [
          { branchId: "primary", label: "primary", status },
          { branchId: "child", label: "child", forkedFromBranchId: "primary", status },
        ] };
      },
    });
    await settle();
    assert.equal(f.button("Resume task").disabled, true);
    assert.equal(f.button("Resume branch").disabled, true);
    await f.button("Resume task").click();
    await f.button("Resume branch").click();
    assert.equal(writes, 0);
    view.dispose();
  });
});

test("recovery resumes a child of a completed primary and displays the child contract and proof", async () => {
  const { createRecoveryView } = await moduleAt("views/recovery.js");
  await inDom(async (f) => {
    const calls: any[] = [];
    let started = false;
    const view = createRecoveryView(f.host, {
      taskId: "task_one", checkpoints: [], dialogs: { confirm: async () => true },
      request: async (path: string, init: any = {}) => {
        calls.push({ path, init });
        if (path.endsWith("/resume")) { started = true; return { taskId: "task_one", branchId: "child", status: "running" }; }
        return { branches: [
          { branchId: "primary", label: "primary", status: "proven" },
          { branchId: "child", forkedFromBranchId: "primary", label: "Try historical fix", status: started ? "proven" : "paused",
            contract: { goal: "Branch-specific goal" }, proof: { branchId: "child", outcome: started ? "proven" : "unproven" } },
        ] };
      },
    });
    await settle();
    await f.button("Resume branch").click();
    assert.deepEqual(JSON.parse(calls.find((entry) => entry.path.endsWith("/resume")).init.body), { branchId: "child" });
    assert.match(f.host.textContent, /Branch-specific goal/);
    assert.match(f.host.textContent, /"branchId": "child"/);
    assert.equal(f.button("Resume task").disabled, true);
    view.dispose();
  });
});

test("recovery runs an explicitly confirmed baseline comparison and labels it observation-only", async () => {
  const { createRecoveryView } = await moduleAt("views/recovery.js");
  await inDom(async (f) => {
    const calls: any[] = [];
    const view = createRecoveryView(f.host, {
      taskId: "task/a",
      checkpoints: [],
      dialogs: { confirm: async () => true },
      request: async (path: string, init: any = {}) => {
        calls.push({ path, init });
        if (path.endsWith("/verify-comparison")) return {
          status: "observed",
          verdict: "baseline_failed_candidate_passed",
          parentProofReused: false,
          evidenceLevel: null,
          limitations: ["local protected checks only"],
          variants: [
            { variant: "baseline", checks: [{ command: "node --test", status: "failed" }] },
            { variant: "candidate", checks: [{ command: "node --test", status: "passed" }] },
          ],
        };
        return { branches: [] };
      },
    });
    await settle();
    await f.button("Verify baseline against candidate").click();
    const comparison = calls.find((entry) => entry.path === "/v1/tasks/task%2Fa/verify-comparison");
    assert.deepEqual(JSON.parse(comparison.init.body), { confirmed: true });
    assert.match(f.host.textContent, /baseline_failed_candidate_passed/);
    assert.match(f.host.textContent, /observation-only|not independent evidence/i);
    view.dispose();
  });
});

test("a refused branch resume remains visible until the user explicitly refreshes", async () => {
  const { createRecoveryView } = await moduleAt("views/recovery.js");
  await inDom(async (f) => {
    const view = createRecoveryView(f.host, {
      taskId: "task_one", checkpoints: [], dialogs: { confirm: async () => true },
      request: async (path: string) => {
        if (path.endsWith("/resume")) throw new Error("recorded extension configuration changed");
        return { branches: [{ branchId: "child", forkedFromBranchId: "primary", label: "Child", status: "executing" }] };
      },
    });
    await settle();
    await f.button("Resume branch").click();
    assert.match(f.host.textContent, /recorded extension configuration changed/);
    view.dispose();
  });
});

test("collaboration and release show endpoint unavailability and never manufacture evidence", async () => {
  const { createCollaborationView, createReadinessView } = await moduleAt("views/collaboration.js");
  assert.equal(typeof createCollaborationView, "function");
  assert.equal(typeof createReadinessView, "function");
  await inDom(async (f) => {
    const calls: string[] = [];
    const request = async (path: string) => { calls.push(path); throw Object.assign(new Error("API pending integration"), { status: 404 }); };
    const collaboration = createCollaborationView(f.host, { request }); await settle();
    assert.match(f.host.textContent, /API pending integration/); assert.match(f.host.textContent, /unavailable/i);
    collaboration.dispose();
    const readiness = createReadinessView(f.host, { request }); await settle();
    assert.match(f.host.textContent, /unavailable/i); assert.doesNotMatch(f.host.textContent, /Ready for release|All gates passed/);
    assert.deepEqual(calls, ["/v1/collaboration", "/v1/release/readiness"]);
    readiness.dispose();
  });
});

test("collaboration verifies explicit JSON bindings and previews only the selected local root", async () => {
  const { createCollaborationView } = await moduleAt("views/collaboration.js");
  await inDom(async (f) => {
    const calls: any[] = [];
    const view = createCollaborationView(f.host, {
      request: async (path: string, init: any = {}) => {
        calls.push({ path, init });
        if (path.endsWith("/verify")) return { ok: false, authority: "integrity_only", reason: "identity rejected" };
        if (path.endsWith("/preview")) return { root: "/fixture", digest: "hash", authority: "read_only" };
        return { version: "keystone.collaboration/1", importAvailable: false, adoptionAvailable: false, delegation: { outboundAvailable: false }, candidates: [] };
      }, dialogs: { confirm: async () => true },
    });
    await settle();
    assert.match(f.host.textContent, /unavailable/i);
    f.host.querySelector("#collaboration-signed").value = '{"document":{},"envelope":{}}';
    f.host.querySelector("#collaboration-expected").value = '{"purpose":"proof","taskId":"t","conditionIds":[]}';
    await f.button("Verify signature").click();
    assert.deepEqual(JSON.parse(calls.find((entry) => entry.path.endsWith("/verify")).init.body), {
      signed: { document: {}, envelope: {} }, expected: { purpose: "proof", taskId: "t", conditionIds: [] },
    });
    assert.match(f.host.textContent, /identity rejected/); assert.match(f.host.textContent, /integrity_only/);
    f.host.querySelector("#collaboration-root").value = "/fixture";
    await f.button("Preview portable package").click();
    assert.deepEqual(JSON.parse(calls.find((entry) => entry.path.endsWith("/preview")).init.body), { root: "/fixture" });
    assert.equal(calls.some((entry) => entry.path.endsWith("/import") || entry.path.endsWith("/delegate")), false);
    view.dispose();
  });
});

test("collaboration rejects malformed JSON and obvious secret fields before making a request", async () => {
  const { createCollaborationView } = await moduleAt("views/collaboration.js");
  await inDom(async (f) => {
    let writes = 0;
    const view = createCollaborationView(f.host, {
      request: async (_path: string, init: any = {}) => { if (init.method) writes += 1; return {}; },
      dialogs: { confirm: async () => true },
    });
    await settle();
    const signed = f.host.querySelector("#collaboration-signed");
    const expected = f.host.querySelector("#collaboration-expected");
    signed.value = "not json"; expected.value = "{}";
    await f.button("Verify signature").click();
    assert.equal(writes, 0); assert.match(f.host.textContent, /valid JSON/i);
    signed.value = '{"document":{"apiKey":"fixture-secret-do-not-send"},"envelope":{}}';
    await f.button("Verify signature").click();
    assert.equal(writes, 0); assert.match(f.host.textContent, /secret/i);
    view.dispose();
  });
});

test("readiness displays actual gate IDs and distinguishes local readiness from stable release", async () => {
  const { createReadinessView } = await moduleAt("views/collaboration.js");
  await inDom(async (f) => {
    const view = createReadinessView(f.host, { request: async () => ({
      releaseVersion: "1.0.0-rc.1", channel: "rc", localReady: true, stableReady: false,
      gates: [{ gateId: "notarization", status: "missing", reason: "No ticket supplied", requiredFor: "stable", evidenceDigest: null }],
    }) });
    await settle();
    assert.match(f.host.textContent, /notarization/); assert.match(f.host.textContent, /No ticket supplied/);
    assert.match(f.host.textContent, /Stable release not ready/);
    assert.doesNotMatch(f.host.textContent, /Ready for release|All gates passed/);
    view.dispose();
  });
});

test("project navigation retains unknown task statuses and uses natural titles", async () => {
  const { groupProjectTasks, taskTitle } = await moduleAt("state/navigation.js");
  assert.equal(typeof groupProjectTasks, "function");
  assert.equal(typeof taskTitle, "function");
  const groups = groupProjectTasks([{ projectId: "p", name: "Project" }], [
    { projectId: "p", taskId: "t", request: "Fix native launch", status: "future_status" },
    { projectId: "p", taskId: "t2", contract: { goal: "Review permissions" }, status: "proven" },
  ], "");
  assert.equal(groups[0].tasks.length, 2);
  assert.equal(taskTitle(groups[0].tasks[1]), "Review permissions");
  assert.equal(groupProjectTasks(groups.map((entry: any) => entry.project), groups[0].tasks, "launch")[0].tasks.length, 1);
});
