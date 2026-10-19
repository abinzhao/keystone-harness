# Workbench Layout B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the dependency-free Keystone workbench around an approved task-focused centre surface with a persistent proof inspector and responsive drawers.

**Architecture:** Keep the existing Runtime API and render functions as the behavioural source of truth. Reorganise the single HTML document into a semantic task rail, task surface, and result inspector; add presentation-only state for inspector tabs and responsive drawers; pin the DOM contract and new strings with `node:test`.

**Tech Stack:** HTML, CSS, dependency-free browser JavaScript, TypeScript `node:test`, Keystone i18n catalogs.

---

## File Map

- Modify `packages/runtime/web/workbench.html`: semantic shell, responsive styling, inspector tabs/drawers, sticky composer, task-focused rendering.
- Modify `packages/runtime/test/server.test.ts`: served-page contract for the approved regions and preserved functional IDs.
- Modify `packages/i18n/src/catalog/zh-CN/workbench.ts`: Chinese translations for new visible and accessible labels.
- Modify `packages/i18n/test/i18n.test.ts`: translation coverage for the new workbench labels.

No Runtime endpoint, Schema, kernel package, or protocol file changes.

### Task 1: Pin the Workbench Contract and New Localisation

**Files:**
- Modify: `packages/runtime/test/server.test.ts:67-72`
- Modify: `packages/i18n/test/i18n.test.ts:51-55`
- Modify: `packages/i18n/src/catalog/zh-CN/workbench.ts:14-92`

- [ ] **Step 1: Write the failing served-page structure assertions**

Replace the existing one-line page assertion in `packages/runtime/test/server.test.ts` with:

```ts
const page = await fetch(`${base}/`);
assert.equal(page.status, 200);
const pageHtml = await page.text();
assert.match(pageHtml, /Keystone — task workbench/);
for (const role of ["task-rail", "task-surface", "result-inspector", "task-composer"]) {
  assert.match(pageHtml, new RegExp(`data-role="${role}"`), role);
}
for (const id of [
  "projects",
  "tasks",
  "goal",
  "conditions",
  "trace",
  "proof",
  "evidence",
  "branches",
  "interventions",
  "run-form",
]) {
  assert.match(pageHtml, new RegExp(`id="${id}"`), id);
}
assert.match(pageHtml, /role="tablist"/);
assert.match(pageHtml, /data-inspector-view="proof"/);
assert.match(pageHtml, /data-inspector-view="evidence"/);
assert.match(pageHtml, /data-inspector-view="branches"/);
assert.match(pageHtml, /data-inspector-view="risks"/);
```

- [ ] **Step 2: Write the failing translation assertions**

Append this test to `packages/i18n/test/i18n.test.ts`:

```ts
test("the task-focused workbench chrome is translated", () => {
  const t = translatorFor("zh-CN");
  assert.equal(t("New task"), "新任务");
  assert.equal(t("Result inspector"), "结果检视器");
  assert.equal(t("Risks"), "风险");
  assert.equal(t("Open task list"), "打开任务列表");
  assert.equal(t("Open result inspector"), "打开结果检视器");
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
node --test packages/runtime/test/server.test.ts packages/i18n/test/i18n.test.ts
```

Expected: FAIL because the new `data-role` regions, tabs, and translation keys do not exist.

- [ ] **Step 4: Add the minimal translations**

Add these entries under the workbench title-bar/static-section groups in `packages/i18n/src/catalog/zh-CN/workbench.ts`:

```ts
"New task": "新任务",
"Result inspector": "结果检视器",
Risks: "风险",
"More actions": "更多操作",
"Open task list": "打开任务列表",
"Close task list": "关闭任务列表",
"Open result inspector": "打开结果检视器",
"Close result inspector": "关闭结果检视器",
"Close panels": "关闭面板",
"Outcome Contract": "结果契约",
"Task details": "任务详情",
```

- [ ] **Step 5: Run the i18n test**

Run:

```bash
node --test packages/i18n/test/i18n.test.ts
```

Expected: PASS. The Runtime structure test still fails, preserving RED for the layout work.

- [ ] **Step 6: Commit the test and translation contract**

```bash
git add packages/runtime/test/server.test.ts packages/i18n/test/i18n.test.ts packages/i18n/src/catalog/zh-CN/workbench.ts
git commit -s -m "test(runtime): pin task-focused workbench contract"
```

### Task 2: Rebuild the Semantic Three-Region Shell

**Files:**
- Modify: `packages/runtime/web/workbench.html:38-767`
- Test: `packages/runtime/test/server.test.ts`

- [ ] **Step 1: Replace the page shell with the approved region ownership**

Keep all existing functional IDs and replace the current `.topbar/.left/.centre/.right/.bottom` skeleton with this structure:

```html
<div class="app" data-layout="task-focused">
  <aside class="task-rail zone" id="task-rail" data-role="task-rail">
    <div class="rail-brand">
      <span class="brand-mark" id="brand-mark"></span>
      <div>
        <div class="brand-name">Keystone</div>
        <div class="brand-sub" data-i18n="task workbench">task workbench</div>
      </div>
      <button class="btn btn-ghost btn-icon rail-close" id="task-rail-close"
        data-i18n-title="Close task list" data-i18n-aria-label="Close task list"></button>
    </div>
    <section class="rail-projects">
      <div class="section-head">
        <h2 data-i18n="Projects">Projects</h2>
        <span class="count" id="project-count"></span>
      </div>
      <div id="projects"></div>
    </section>
    <button class="new-task-button" id="new-task-button" type="button">
      <span data-i18n="New task">New task</span><kbd>⌘ K</kbd>
    </button>
    <section class="rail-tasks">
      <div class="section-head">
        <h2 data-i18n="Tasks">Tasks</h2>
        <span class="count" id="task-count"></span>
      </div>
      <div id="tasks"></div>
    </section>
    <section class="rail-cognition">
      <h2 data-i18n="Cognition and experience">Cognition and experience</h2>
      <div id="cognition"><p class="empty" data-i18n="Select a task to inspect what it was told.">Select a task to inspect what it was told.</p></div>
    </section>
  </aside>

  <main class="task-surface" data-role="task-surface">
    <header class="task-header">
      <button class="btn btn-ghost btn-icon panel-toggle" id="task-rail-toggle"
        data-i18n-title="Open task list" data-i18n-aria-label="Open task list"></button>
      <div class="task-heading">
        <div class="task-heading-title" id="task-heading-title" data-i18n="No task selected.">No task selected.</div>
        <div class="task-context">
          <span id="project" data-i18n="no project selected">no project selected</span>
          <span id="branch" hidden></span>
        </div>
      </div>
      <span id="run-state" class="pill"><span class="dot"></span><span id="run-state-text">idle</span></span>
      <div class="task-actions">
        <button class="btn btn-sm" id="pause" disabled data-i18n="Pause">Pause</button>
        <button class="btn btn-sm" id="stop" disabled data-i18n="Stop">Stop</button>
        <button class="btn btn-sm" id="diff" disabled data-i18n="View change">View change</button>
        <button class="btn btn-ghost btn-icon" id="more-actions" hidden
          data-i18n-title="More actions" data-i18n-aria-label="More actions"></button>
      </div>
      <button class="btn btn-ghost inspector-toggle" id="inspector-toggle"
        data-i18n-title="Open result inspector" data-i18n-aria-label="Open result inspector">
        <span data-i18n="Proof">Proof</span>
        <span id="pending" class="action" hidden></span>
      </button>
    </header>

    <div class="task-scroll zone">
      <section class="goal-section">
        <div class="eyebrow" data-i18n="Outcome Contract">Outcome Contract</div>
        <div id="goal"><p class="empty lg"><span class="mark">◎</span><span data-i18n="No task selected.">No task selected.</span></p></div>
      </section>
      <section class="trace-section">
        <div class="section-head">
          <h2 data-i18n="Stage and trace">Stage and trace</h2>
          <label class="raw-events-toggle">
            <input type="checkbox" id="trace-all" />
            <span data-i18n="show raw events">show raw events</span>
          </label>
        </div>
        <div id="trace"><p class="empty" data-i18n="No events yet.">No events yet.</p></div>
      </section>
    </div>

    <div class="task-composer" data-role="task-composer">
      <form id="run-form">
        <textarea id="request" rows="2" placeholder="Describe the task…" data-i18n-placeholder="Describe the task…"></textarea>
        <div class="composer-tools">
          <label><span data-i18n="workspace">workspace</span><input id="workspace" placeholder="/path/to/git/project" data-i18n-placeholder="/path/to/git/project" /></label>
          <label><span data-i18n="write paths">write paths</span><input id="write-paths" placeholder="src/**" data-i18n-placeholder="src/**" /></label>
          <div class="cost" id="cost"></div>
          <button type="submit" id="run-button" class="btn btn-primary" data-i18n="Start task">Start task</button>
        </div>
      </form>
    </div>
  </main>

  <aside class="result-inspector zone" id="result-inspector" data-role="result-inspector">
    <header class="inspector-header">
      <strong data-i18n="Result inspector">Result inspector</strong>
      <span class="protocol" id="protocol"></span>
      <button class="btn btn-ghost btn-icon inspector-close" id="inspector-close"
        data-i18n-title="Close result inspector" data-i18n-aria-label="Close result inspector"></button>
    </header>
    <section class="decision-section">
      <div class="section-head">
        <h2 data-i18n="Needs your decision">Needs your decision</h2>
        <span class="count" id="intervention-count"></span>
      </div>
      <div id="interventions"><p class="empty" data-i18n="Nothing waiting.">Nothing waiting.</p></div>
    </section>
    <div class="inspector-tabs" role="tablist" aria-label="Result inspector"
      data-i18n-aria-label="Result inspector">
      <button role="tab" data-inspector-view="proof" aria-selected="true" data-i18n="Proof">Proof</button>
      <button role="tab" data-inspector-view="evidence" aria-selected="false" data-i18n="Evidence">Evidence</button>
      <button role="tab" data-inspector-view="branches" aria-selected="false" data-i18n="Branches">Branches</button>
      <button role="tab" data-inspector-view="risks" aria-selected="false" data-i18n="Risks">Risks</button>
    </div>
    <section data-inspector-panel="proof">
      <div id="proof"><p class="empty" data-i18n="No proof yet.">No proof yet.</p></div>
      <div class="conditions-head"><span data-i18n="Completion conditions">Completion conditions</span><span id="condition-count"></span></div>
      <div id="conditions"><p class="empty" data-i18n="No contract yet.">No contract yet.</p></div>
      <button class="btn btn-sm" id="export-proof" disabled data-i18n="Export proof">Export proof</button>
    </section>
    <section data-inspector-panel="evidence" hidden>
      <span class="count" id="evidence-count"></span>
      <div id="evidence"><p class="empty" data-i18n="No evidence recorded.">No evidence recorded.</p></div>
    </section>
    <section data-inspector-panel="branches" hidden>
      <div id="branches"><p class="empty" data-i18n="No branches yet.">No branches yet.</p></div>
    </section>
    <section data-inspector-panel="risks" hidden>
      <div id="risks"></div>
      <button class="btn btn-sm" id="revise" disabled data-i18n="Add constraints">Add constraints</button>
      <button class="btn btn-ghost btn-icon" id="theme-toggle"></button>
      <button class="btn btn-ghost btn-icon" id="data-button"
        data-i18n-title="Local data" data-i18n-aria-label="Local data"></button>
      <button class="btn btn-ghost btn-icon" id="refresh"
        data-i18n-title="Refresh" data-i18n-aria-label="Refresh"></button>
    </section>
  </aside>
  <button class="panel-scrim" id="panel-scrim" tabindex="-1" hidden
    data-i18n-aria-label="Close panels"></button>
</div>
```

- [ ] **Step 2: Implement the desktop layout CSS**

Define stable columns and ownership:

```css
.app {
  display: grid;
  grid-template-columns: clamp(216px, 18vw, 248px) minmax(520px, 1fr) clamp(306px, 25vw, 336px);
  grid-template-areas: "rail surface inspector";
  height: 100vh;
  overflow: hidden;
}
.task-rail { grid-area: rail; display: flex; flex-direction: column; background: var(--surface-2); border-right: 1px solid var(--line); }
.task-surface { grid-area: surface; position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; background: var(--surface); }
.result-inspector { grid-area: inspector; background: var(--surface-2); border-left: 1px solid var(--line); }
.task-scroll { padding: 0 clamp(24px, 4vw, 64px) 24px; }
.goal-section, .trace-section { width: min(100%, 760px); margin-inline: auto; border: 0; }
.task-composer { padding: 12px clamp(24px, 4vw, 64px) 18px; background: linear-gradient(transparent, var(--surface) 22%); }
.task-composer form { width: min(100%, 760px); margin-inline: auto; border: 1px solid var(--line-2); border-radius: 10px; background: var(--surface); box-shadow: var(--shadow); }
.inspector-tabs { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--line); }
.inspector-tabs button[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
```

- [ ] **Step 3: Implement medium and narrow breakpoints**

```css
@media (max-width: 1179px) {
  .app { grid-template-columns: clamp(208px, 24vw, 240px) minmax(0, 1fr); grid-template-areas: "rail surface"; }
  .result-inspector {
    position: fixed;
    inset: 0 0 0 auto;
    width: min(360px, 92vw);
    z-index: 30;
    transform: translateX(100%);
    transition: transform 160ms ease;
  }
  .app[data-inspector-open="true"] .result-inspector { transform: translateX(0); }
  .inspector-toggle, .inspector-close { display: inline-flex; }
}
@media (max-width: 759px) {
  .app { display: block; }
  .task-rail {
    position: fixed;
    inset: 0 auto 0 0;
    width: min(286px, 88vw);
    z-index: 31;
    transform: translateX(-100%);
    transition: transform 160ms ease;
  }
  .app[data-rail-open="true"] .task-rail { transform: translateX(0); }
  .task-header { padding-inline: 10px; }
  .task-actions > :not(#diff) { display: none; }
  .task-scroll { padding-inline: 16px; }
  .task-composer { padding: 8px 10px max(10px, env(safe-area-inset-bottom)); }
  .composer-tools label { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .result-inspector, .task-rail { transition: none; }
}
```

- [ ] **Step 4: Run the Runtime test and verify GREEN**

Run:

```bash
node --test packages/runtime/test/server.test.ts
```

Expected: PASS, including the region, tab, and preserved-ID assertions.

- [ ] **Step 5: Commit the semantic shell**

```bash
git add packages/runtime/web/workbench.html
git commit -s -m "feat(runtime): adopt task-focused workbench shell"
```

### Task 3: Add Accessible Inspector Tabs and Responsive Drawers

**Files:**
- Modify: `packages/runtime/web/workbench.html:834-846`
- Modify: `packages/runtime/web/workbench.html:1729-1830`
- Test: `packages/runtime/test/server.test.ts`

- [ ] **Step 1: Add presentation-only state**

Extend the browser state object:

```js
inspectorView: "proof",
taskRailOpen: false,
inspectorOpen: false,
```

- [ ] **Step 2: Add panel and tab helpers**

Add these helpers before `main()`:

```js
const INSPECTOR_VIEWS = new Set(["proof", "evidence", "branches", "risks"]);

function setInspectorView(view) {
  if (!INSPECTOR_VIEWS.has(view)) return;
  state.inspectorView = view;
  for (const tab of document.querySelectorAll("[data-inspector-view]")) {
    const selected = tab.dataset.inspectorView === view;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of document.querySelectorAll("[data-inspector-panel]")) {
    panel.hidden = panel.dataset.inspectorPanel !== view;
  }
}

function setPanelOpen(panel, open) {
  if (panel === "rail") state.taskRailOpen = open;
  if (panel === "inspector") state.inspectorOpen = open;
  const app = document.querySelector(".app");
  app.dataset.railOpen = String(state.taskRailOpen);
  app.dataset.inspectorOpen = String(state.inspectorOpen);
  el("panel-scrim").hidden = !(state.taskRailOpen || state.inspectorOpen);
}

function closeTransientPanels() {
  setPanelOpen("rail", false);
  setPanelOpen("inspector", false);
}
```

- [ ] **Step 3: Wire tabs, drawers, keyboard controls, and New Task**

Add in `main()`:

```js
for (const tab of document.querySelectorAll("[data-inspector-view]")) {
  tab.addEventListener("click", () => setInspectorView(tab.dataset.inspectorView));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll("[data-inspector-view]")];
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
    setInspectorView(next.dataset.inspectorView);
    next.focus();
  });
}
el("task-rail-toggle").addEventListener("click", () => setPanelOpen("rail", true));
el("task-rail-close").addEventListener("click", () => setPanelOpen("rail", false));
el("inspector-toggle").addEventListener("click", () => setPanelOpen("inspector", true));
el("inspector-close").addEventListener("click", () => setPanelOpen("inspector", false));
el("panel-scrim").addEventListener("click", closeTransientPanels);
el("new-task-button").addEventListener("click", () => {
  closeTransientPanels();
  el("request").focus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeTransientPanels();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    el("request").focus();
  }
});
setInspectorView("proof");
```

Change the pending badge handler so it opens the inspector and selects the decision area:

```js
el("pending").addEventListener("click", () => {
  setPanelOpen("inspector", true);
  el("interventions").scrollIntoView({ block: "start", behavior: "smooth" });
});
```

- [ ] **Step 4: Extend static i18n to accessible names**

Add to `applyStaticI18n()`:

```js
for (const node of document.querySelectorAll("[data-i18n-aria-label]")) {
  node.setAttribute("aria-label", tr(node.getAttribute("data-i18n-aria-label")));
}
```

Use `data-i18n-aria-label` on icon-only drawer and overflow controls while keeping `data-i18n-title` for tooltips.
In `applyTheme()`, set the theme button's accessible name from the same translated title:

```js
button.setAttribute("aria-label", button.title);
```

- [ ] **Step 5: Add the task heading and risk projection**

In `renderTitles()`:

```js
el("task-heading-title").textContent = detail?.contract?.goal ?? tr("No task selected.");
```

Add:

```js
function renderRisks() {
  const detail = state.detail;
  const proof = state.proof;
  const risks = [
    [tr("In scope"), proof?.changes?.withinScope === false ? tr("no") : tr("yes")],
    [tr("Unverified"), String(proof?.unverified?.length ?? 0)],
    [tr("Residual risks"), String(proof?.residualRisks?.length ?? 0)],
    [tr("Open questions in the contract"), String(detail?.contract?.unknowns?.length ?? 0)],
  ];
  el("risks").innerHTML = risks
    .map(([label, value]) => `<div class="kv"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`)
    .join("");
}
```

Call `renderRisks()` from `renderAll()`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test packages/runtime/test/server.test.ts packages/i18n/test/i18n.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the responsive interactions**

```bash
git add packages/runtime/web/workbench.html packages/i18n/src/catalog/zh-CN/workbench.ts packages/i18n/test/i18n.test.ts
git commit -s -m "feat(runtime): add responsive workbench inspector"
```

### Task 4: Align Rendered Content With the Approved Hierarchy

**Files:**
- Modify: `packages/runtime/web/workbench.html:1114-1497`
- Test: `packages/runtime/test/server.test.ts`

- [ ] **Step 1: Make the Contract goal the primary heading**

In `renderGoal()`, render the goal and metadata with semantic classes:

```js
host.innerHTML =
  integrity + degradation +
  `<h1 class="goal-text">${esc(contract?.goal ?? tr("No contract yet."))}</h1>` +
  `<div class="goal-summary">${esc(contract?.invariants?.[0]?.description ?? "")}</div>` +
  `<div class="contract-meta">` +
  `<span class="chip">${esc(tr("contract v{version}", { version: contract?.version ?? "—" }))}</span>` +
  (writeChips || `<span class="chip">${esc(tr("(nothing writable)"))}</span>`) +
  `<span class="chip">${esc(tr("{n} events", { n: detail.ledger?.events ?? 0 }))}</span>` +
  `</div>` +
  `<div class="stages">${steps}</div>` +
  invariants + uncertaintyBlock;
```

Keep ledger-integrity, degradation, scope, invariant, uncertainty, replay, and proof validity information; remove only duplicate framing.

- [ ] **Step 2: Flatten the key trace**

Keep the trace summary and event mapping, but style them as an open stream rather than nested cards:

```css
.trace-summary { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.trace-section .card { border: 0; border-top: 1px solid var(--line); border-radius: 0; background: transparent; padding-inline: 0; }
.timeline { margin-top: 8px; }
.event { padding-block: 10px; }
```

Raw events remain controlled by `#trace-all`; no chain-of-thought is added.

- [ ] **Step 3: Make Proof own completion conditions**

Place `#conditions` in the Proof inspector panel directly after `#proof`. Keep `renderConditions()` unchanged except for inspector-appropriate spacing. This preserves per-condition semantics while removing the separate centre column section.

- [ ] **Step 4: Keep actions in their owning regions**

- Pause, Stop, and View change stay in the task header.
- Add constraints, Export proof, theme, refresh, and local data stay in inspector views.
- Starting a task stays in the composer.
- Pending decisions stay pinned above inspector tabs.

Do not add a custom actions menu in this iteration; hide `#more-actions` until it owns a real command.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test packages/runtime/test/server.test.ts packages/runtime/test/workbench-api.test.ts packages/i18n/test/i18n.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the visual hierarchy**

```bash
git add packages/runtime/web/workbench.html
git commit -s -m "feat(runtime): align workbench task and proof hierarchy"
```

### Task 5: Browser Verification and Full Regression

**Files:**
- Modify if needed: `packages/runtime/web/workbench.html`
- Modify if needed: `packages/i18n/src/catalog/zh-CN/workbench.ts`

- [ ] **Step 1: Run full static verification**

```bash
pnpm run typecheck
pnpm test
```

Expected: both commands exit 0.

- [ ] **Step 2: Start the real local workbench**

Run:

```bash
node packages/cli/src/bin.ts serve --port 7801
```

Open the printed loopback URL, including its token fragment.

- [ ] **Step 3: Verify wide desktop**

At 1440 x 900:

- Task rail, task surface, and result inspector are simultaneously visible.
- The Contract goal and task stream dominate the centre.
- The composer does not cover the final trace event.
- Proof is selected by default and conditions are readable.
- Pending decisions remain above tabs.
- Task selection, task creation, pause/stop, revision, diff, proof export, theme, refresh, and local data remain reachable.

- [ ] **Step 4: Verify medium and narrow layouts**

At 1024 x 768:

- Inspector is closed by default and opens from the labelled Proof control.
- Scrim and Escape close the inspector.
- The task rail remains visible.

At 390 x 844:

- Task rail opens as a side sheet and closes via button, scrim, and Escape.
- Proof opens as a full-height view.
- Composer remains visible without horizontal page scrolling.
- Goal, task status, and action labels do not overlap.

- [ ] **Step 5: Verify accessibility and diagnostics**

- Switch light/dark themes.
- Emulate reduced motion.
- Keyboard through rail, header, tabs, composer, drawer, and dialogs.
- Confirm inspector tabs respond to Left/Right arrows.
- Check browser console and page errors.
- Confirm all new Chinese labels render under the default language and English remains the source text under `--lang en`.

- [ ] **Step 6: Capture screenshots and compare with the approved concept**

Capture 1440 x 900 and 390 x 844 screenshots. Inspect the approved concept and the implementation for:

1. three-region hierarchy,
2. task-focused centre width,
3. persistent Proof visibility on wide screens,
4. sticky composer placement,
5. typography and colour hierarchy,
6. responsive drawer behaviour,
7. absence of clipping or overlap.

- [ ] **Step 7: Review the final diff**

```bash
git diff --check
git status --short
git diff HEAD~3 -- packages/runtime/web/workbench.html packages/runtime/test/server.test.ts packages/i18n/src/catalog/zh-CN/workbench.ts packages/i18n/test/i18n.test.ts
```

Expected: no whitespace errors, debug code, unrelated files, generated assets, protocol changes, or sensitive data.

- [ ] **Step 8: Commit any verification fixes**

If browser verification required fixes:

```bash
git add packages/runtime/web/workbench.html packages/i18n/src/catalog/zh-CN/workbench.ts
git commit -s -m "fix(runtime): polish responsive workbench layout"
```
