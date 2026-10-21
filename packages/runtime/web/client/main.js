import { createApi, post, projectPath, taskPath } from "./api.js";
import { createWorkbenchClient } from "../state/workbench.js";
import { createDraftStore } from "../state/drafts.js";
import { createFileClient } from "../state/files.js";
import { el, node, button, field, tr, note, icon, notify, translateStatic, localGet, localSet } from "../components/dom.js";
import { createDialogs } from "../components/dialog.js";
import { renderDiff } from "../components/diff.js";
import { renderOverview, renderTrace, renderInspector, proofIsCurrent } from "../views/task.js";
import { createCommandsView } from "../views/commands.js";
import { createFilesView } from "../views/files.js";
import { createSettingsView } from "../views/settings.js";
import { createComposer } from "../views/composer.js";
import { fileReference, routedModels } from "../state/composer.js";

const token = new URLSearchParams(location.hash.slice(1)).get("t") ?? "";
const request = createApi({ token });
const client = createWorkbenchClient({ request });
let storage;
try { storage = localStorage; } catch { storage = null; }
const drafts = createDraftStore(storage);
const dialogs = createDialogs();
const app = el("app");
let view = "overview";
let mounted = null;
let mountedView = "";
let viewVersion = 0;
let diffController = null;
let settings = null;
let capabilities = {};
let shell = null;
let composer;
let disposed = false;
let ready = false;
let previousNotification = "";
const tracePreferences = { all: false, search: "" };
const files = createFileClient({ request, onMutation(projectId) {
  if (client.state.projectId === projectId && client.state.taskId) void client.reconnect();
} });

function presentation(value) {
  const theme = ["light", "dark", "system"].includes(value?.theme) ? value.theme : "system";
  const density = value?.density === "compact" ? "compact" : "comfortable";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = density;
  localSet("keystone.theme", theme); localSet("keystone.density", density);
}
presentation({ theme: localGet("keystone.theme"), density: localGet("keystone.density") });
translateStatic();
document.documentElement.lang = globalThis.KEYSTONE_LANG ?? "en";
document.title = tr("Keystone task workbench");
for (const [id, name] of [["sidebar-toggle", "navigation"], ["settings-button", "settings"], ["inspector-toggle", "proof"]]) {
  el(id).replaceChildren(icon(name)); el(id).setAttribute("aria-label", tr(el(id).dataset.i18nTitle));
}
el("command-button").firstChild.textContent = `${tr("Search")} `;

function setPanel(kind, open) {
  const narrow = kind === "sidebar" ? matchMedia("(max-width: 999px)").matches : matchMedia("(max-width: 1279px)").matches;
  app.classList.toggle(`${kind}-open`, narrow && open);
  app.classList.toggle(`${kind}-collapsed`, !open);
  el(`${kind}-toggle`).setAttribute("aria-expanded", String(open));
  el(kind).inert = !open;
  if (narrow) {
    el(kind).setAttribute("aria-label", tr(kind === "sidebar" ? "Navigation drawer; Escape closes" : "Proof drawer; Escape closes"));
    if (open) el(kind).querySelector("button")?.focus();
  } else localSet(`keystone.panel.${client.state.projectId}.${kind}`, open ? "1" : "0");
}
function closeDrawers() {
  if (matchMedia("(max-width: 999px)").matches) setPanel("sidebar", false);
  if (matchMedia("(max-width: 1279px)").matches) setPanel("inspector", false);
}
function restorePanels() {
  for (const kind of ["sidebar", "inspector"]) {
    const narrow = matchMedia(kind === "sidebar" ? "(max-width: 999px)" : "(max-width: 1279px)").matches;
    setPanel(kind, !narrow && localGet(`keystone.panel.${client.state.projectId}.${kind}`) !== "0");
    const width = Number(localGet(`keystone.width.${client.state.projectId}.${kind}`));
    if (width) applyWidth(kind, width);
  }
}
function applyWidth(kind, value) {
  const control = el(`${kind}-resize`);
  const next = Math.max(Number(control.getAttribute("aria-valuemin")), Math.min(Number(control.getAttribute("aria-valuemax")), value));
  document.documentElement.style.setProperty(`--${kind}`, `${next}px`);
  control.setAttribute("aria-valuenow", String(next));
  localSet(`keystone.width.${client.state.projectId}.${kind}`, String(next));
}
for (const kind of ["sidebar", "inspector"]) {
  el(`${kind}-toggle`).onclick = () => setPanel(kind, el(`${kind}-toggle`).getAttribute("aria-expanded") !== "true");
  const handle = el(`${kind}-resize`);
  handle.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Number(handle.getAttribute("aria-valuenow"));
    applyWidth(kind, event.key === "Home" ? Number(handle.getAttribute("aria-valuemin")) : event.key === "End" ? Number(handle.getAttribute("aria-valuemax")) : current + (event.key === "ArrowRight" ? 1 : -1) * (kind === "sidebar" ? 1 : -1) * (event.shiftKey ? 30 : 10));
  };
  handle.onpointerdown = (event) => {
    const start = event.clientX; const width = Number(handle.getAttribute("aria-valuenow"));
    handle.setPointerCapture(event.pointerId);
    handle.onpointermove = (move) => applyWidth(kind, width + (move.clientX - start) * (kind === "sidebar" ? 1 : -1));
    handle.onpointerup = () => { handle.onpointermove = null; };
    handle.onpointercancel = () => { handle.onpointermove = null; };
  };
}
window.addEventListener("resize", restorePanels);

const titleOf = (task) => task.title || task.request || task.headline || task.taskId;
function renderNavigation() {
  const state = client.state;
  const projects = state.projects.filter((project) => !project.archived || project.projectId === state.projectId)
    .slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  el("project-select").replaceChildren(node("option", { value: "", text: tr("Select project") }), ...projects.map((project) => node("option", { value: project.projectId, text: project.name || project.rootPath, selected: project.projectId === state.projectId })));
  el("project-list").replaceChildren();
  for (const project of projects) {
    const item = button(project.name || project.rootPath, () => selectProject(project.projectId), `nav-item ${state.projectId === project.projectId ? "active" : ""}`);
    item.append(node("small", { text: `${project.pinned ? `${tr("Pinned")} · ` : ""}${project.branch ?? project.currentBranch ?? ""}${project.status ? ` · ${tr(project.status)}` : ""}` }));
    el("project-list").append(item);
  }
  if (!projects.length) el("project-list").append(note("No projects yet."));
  const tasks = state.tasks.filter((task) => task.projectId === state.projectId);
  el("task-select").replaceChildren(node("option", { value: "", text: tr("New task") }), ...tasks.map((task) => node("option", { value: task.taskId, text: titleOf(task), selected: task.taskId === state.taskId })));
  const search = el("task-filter").value.toLocaleLowerCase();
  el("task-list").replaceChildren();
  const groups = [["Needs you", ["needs_attention", "awaiting_approval", "failed", "unrecoverable"]], ["Running", ["executing", "verifying", "auto_repairing", "resuming"]], ["Waiting", ["draft", "defining", "ready", "paused"]], ["Proven", ["proven"]], ["Exited", ["stopped", "exited_gracefully"]]];
  for (const [label, statuses] of groups) {
    const grouped = tasks.filter((task) => statuses.includes(task.status) && titleOf(task).toLocaleLowerCase().includes(search));
    if (!grouped.length) continue;
    el("task-list").append(node("div", { class: "nav-group", text: tr(label) }));
    for (const task of grouped) {
      const item = button(titleOf(task), () => selectTask(task.taskId), `nav-item ${task.taskId === state.taskId ? "active" : ""}`);
      item.append(node("small", { text: tr(task.status) })); el("task-list").append(item);
    }
  }
  if (!tasks.length) el("task-list").append(note("No tasks yet. Start one below."));
  el("project-manage").disabled = !state.projectId;
}

async function leaveSettings() {
  if (view === "settings" && mounted?.dirty) {
    if (!(await dialogs.confirm("Discard settings draft", note("Leaving settings discards unsaved configuration changes."), "Discard draft", true))) return false;
    if (settings) presentation(settings.presentation);
  }
  return true;
}
async function selectProject(projectId) {
  if (!(await leaveSettings())) { renderNavigation(); return; }
  dialogs.close();
  client.selectProject(projectId || null);
  localSet("keystone.project", projectId ?? "");
  files.setProject(projectId || null);
  view = "overview"; mountedView = ""; restorePanels(); closeDrawers();
  composer?.newTask();
  render();
}
async function selectTask(taskId) {
  if (!(await leaveSettings())) { renderNavigation(); return; }
  const summary = client.state.tasks.find((entry) => entry.taskId === taskId);
  if (summary?.projectId && summary.projectId !== client.state.projectId) {
    client.selectProject(summary.projectId); files.setProject(summary.projectId);
  }
  view = "overview"; mountedView = ""; closeDrawers();
  await client.selectTask(taskId || null);
  render();
}
async function showView(next) {
  if (next === view) return;
  if (next !== view && !(await leaveSettings())) return;
  view = next; mountedView = ""; render();
}
function renderView() {
  const host = el("view-host");
  const selection = `${view}:${client.state.projectId}:${client.state.taskId}`;
  if (mountedView !== selection) {
    mounted?.dispose?.(); mounted = null; diffController?.abort(); viewVersion += 1;
    host.replaceChildren(); mountedView = selection;
    if (view === "files") mounted = createFilesView(host, { files, request, dialogs, reference: (value) => composer.reference(value) });
    else if (view === "commands") mounted = createCommandsView(host, {
      state: client.state, request, dialogs, refresh: async () => { await client.refreshLists(); await client.reconnect(); },
    });
    else if (view === "settings") mounted = createSettingsView(host, {
      request, dialogs, state: client.state, capabilities, shell, onPresentation: presentation,
      async onSaved(saved) {
        settings = saved;
        if (saved.config.language && saved.config.language !== globalThis.KEYSTONE_LANG) {
          const value = await request(`/v1/settings/catalog?${new URLSearchParams({ language: saved.config.language })}`);
          globalThis.KEYSTONE_LANG = value.language; globalThis.KEYSTONE_I18N = value.catalog;
          translateStatic(); document.documentElement.lang = value.language;
          for (const id of ["sidebar-toggle", "settings-button", "inspector-toggle"]) el(id).setAttribute("aria-label", tr(el(id).dataset.i18nTitle));
          el("command-button").firstChild.textContent = `${tr("Search")} `;
          document.title = tr("Keystone task workbench");
          mountedView = "";
          composer.dispose(); composer = mountComposer();
        }
        capabilities = await request("/v1/capabilities");
        composer.refresh(); render();
      },
      async openNativeConfiguration() {
        if (!(await leaveSettings())) return;
        mounted?.dispose?.(); mounted = null; mountedView = "";
        await onboarding(); render();
      },
    });
    else if (view === "diff") {
      const taskId = client.state.taskId; const selectedVersion = viewVersion;
      if (!taskId) { host.append(note("Select a task to inspect changes.")); return; }
      diffController = new AbortController(); host.append(note("Loading changes"));
      void request(`${taskPath(taskId)}/diff`, { signal: diffController.signal }).then((data) => {
        if (selectedVersion === viewVersion && !disposed) renderDiff(host, data, (path, line) => composer.reference(fileReference(path, line)));
      }).catch((error) => { if (selectedVersion === viewVersion && error.name !== "AbortError") host.replaceChildren(note(error.message, "bad")); });
    }
  }
  if (view === "overview") renderOverview(host, client.state);
  if (view === "trace") renderTrace(host, client.state, tracePreferences);
  if (view === "commands") mounted?.update();
  for (const item of el("workspace-tabs").querySelectorAll("button")) {
    if (item.dataset.view === view) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
  }
}
function render() {
  if (disposed) return;
  const state = client.state;
  renderNavigation();
  const project = state.projects.find((entry) => entry.projectId === state.projectId);
  const task = state.tasks.find((entry) => entry.taskId === state.taskId);
  el("task-title").textContent = view === "settings" ? tr("Settings") : task ? titleOf(task) : project?.name ?? tr("Local workbench");
  el("workspace-branch").textContent = project ? `${project.name} · ${project.branch ?? project.currentBranch ?? tr("Branch unknown")}` : tr("Local-first engineering");
  el("task-status").textContent = tr(state.detail?.status ?? (state.loading ? "Loading task" : "idle"));
  el("pause").disabled = state.run?.status !== "running";
  el("stop").disabled = !state.detail || !["executing", "verifying", "auto_repairing", "paused", "needs_attention", "awaiting_approval", "ready", "defining"].includes(state.detail.status);
  el("export-proof").disabled = !state.proof;
  el("error").hidden = !state.error; el("error").textContent = state.error;
  el("connection").textContent = tr(state.connection === "stale" ? "Disconnected; showing last known state" : state.loading ? "Loading task" : state.connection === "connected" ? "Connected locally" : "Connecting");
  el("workspace-status").textContent = project ? `${project.rootPath} · ${tr(project.dirty ? "Uncommitted changes" : "Workspace")}` : tr("No project selected");
  const models = routedModels(settings?.config, "builder", capabilities.egress ?? []);
  el("route-status").textContent = models.length ? `${models[0].modelName} · ${tr(models[0].kind === "local" ? "Local" : "Cloud")}` : tr("No model configured");
  const usage = state.detail?.budgetUsed;
  el("budget-status").textContent = usage ? `${usage.tokens ?? 0} tokens · ${usage.retries ?? 0} ${tr("retries")} · ${Math.round((usage.wallClockMs ?? 0) / 1000)}s` : "";
  const pending = state.run?.pendingInterventions?.length ?? 0;
  el("pending-button").textContent = tr("{n} pending", { n: pending });
  renderInspector(state, { request, dialogs, drafts, refresh: async (taskId) => { if (taskId === client.state.taskId) await client.reconnect(); } });
  renderView();
  const signature = `${state.taskId}:${state.detail?.status}:${pending}`;
  if (signature !== previousNotification) {
    if (previousNotification && state.connection === "connected" && (pending || proofIsCurrent(state)) && localGet("keystone.notifications") === "1" && globalThis.Notification?.permission === "granted") {
      new Notification("Keystone", { body: pending ? tr("Needs your decision") : tr("Safe to deliver"), tag: state.taskId });
    }
    previousNotification = signature;
  }
}

async function addProject() {
  const root = field("Git project path", "project-root");
  const name = field("Project display name (optional)", "project-name");
  const status = node("div", { role: "status" });
  const content = node("div", { class: "form-grid" }, [
    note("Registering a project does not start a task or modify repository code."), root.wrap, name.wrap, status,
  ]);
  if (shell) content.append(button("Choose folder", async () => {
    const result = await request("/desktop/pick-folder", post({}));
    if (result.path) root.input.value = result.path; else status.replaceChildren(note(result.error ?? "Folder picker unavailable.", "warn"));
  }));
  dialogs.open("Add project", content, [button("Cancel", () => dialogs.close()), button("Add project", async (event) => {
    if (!root.input.value.trim()) { root.input.focus(); return; }
    const clicked = event.currentTarget; clicked.disabled = true;
    const selectedDialog = dialogs.generation;
    try {
      const result = await request("/v1/projects", post({ rootPath: root.input.value.trim(), ...(name.input.value.trim() ? { name: name.input.value.trim() } : {}) }));
      if (selectedDialog === dialogs.generation) { dialogs.close(); await client.refreshLists(); await selectProject(result.project.projectId); }
      else await client.refreshLists();
    } catch (error) { status.replaceChildren(note(error.message, "bad")); }
    finally { clicked.disabled = false; }
  }, "primary")]);
}
async function manageProject() {
  const project = client.state.projects.find((entry) => entry.projectId === client.state.projectId);
  if (!project) return;
  const mutate = async (patch) => {
    await request(projectPath(project.projectId), { method: "PATCH", body: JSON.stringify(patch) });
    dialogs.close(); await client.refreshLists(); render();
  };
  const body = node("div", { class: "stack" }, [jsonReadableProject(project)]);
  body.append(button(project.pinned ? "Unpin project" : "Pin project", () => mutate({ pinned: !project.pinned })));
  body.append(button("Rename project", async () => {
    const value = await dialogs.prompt("Rename project", "Project display name", project.name);
    if (value) await mutate({ name: value });
  }));
  body.append(button(project.archived ? "Unarchive project" : "Archive project", () => mutate({ archived: !project.archived })));
  body.append(button("Reconnect project path", async () => {
    const path = await dialogs.prompt("Reconnect project", "Git project path", project.rootPath);
    if (path) await mutate({ rootPath: path });
  }));
  body.append(button("Remove project metadata", async () => {
    const tasks = client.state.tasks.filter((entry) => entry.projectId === project.projectId);
    if (!(await dialogs.confirm("Remove project metadata", node("div", {}, [note("Only the registry entry is removed. Code and existing task evidence are not deleted."), node("p", { text: tr("{name}: {count} retained tasks", { name: project.name, count: tasks.length }) })]), "Remove project metadata", true))) return;
    await request(projectPath(project.projectId), { method: "DELETE" });
    await selectProject(null); await client.refreshLists();
  }, "danger"));
  dialogs.open("Manage project", body);
}
function jsonReadableProject(project) { return node("div", {}, [node("h3", { text: project.name }), node("code", { text: project.rootPath }), node("p", { text: `${tr("Workspace")}: ${project.workspaceId ?? project.projectId} · ${project.scanStatus ?? project.status ?? tr("Unknown")}` })]); }

function commandPalette(filesOnly = false) {
  const search = node("input", { type: "search", "aria-label": tr(filesOnly ? "Search project files" : "Command palette"), placeholder: tr(filesOnly ? "Search project files" : "Search projects, tasks, files and commands") });
  const results = node("div", { class: "command-results" });
  const content = node("div", {}, [search, results]);
  const selectedDialog = dialogs.open(filesOnly ? "Reference a file" : "Command palette", content);
  let generation = 0;
  let pending = null;
  const paint = async () => {
    const current = ++generation; pending?.abort(); results.replaceChildren();
    const query = search.value.toLocaleLowerCase();
    if (!filesOnly) {
      for (const [label, action] of [["New task", () => composer.newTask()], ["Add project", addProject], ["Settings", () => showView("settings")], ["Files", () => showView("files")], ["Needs your decision", () => setPanel("inspector", true)]]) {
        if (tr(label).toLocaleLowerCase().includes(query)) results.append(button(label, () => { dialogs.close(); return action(); }));
      }
      for (const project of client.state.projects) if ((project.name ?? project.rootPath).toLocaleLowerCase().includes(query)) results.append(button(`${tr("Project")}: ${project.name}`, () => { dialogs.close(); return selectProject(project.projectId); }));
      for (const task of client.state.tasks) if (titleOf(task).toLocaleLowerCase().includes(query)) results.append(button(`${tr("Task")}: ${titleOf(task)}`, () => { dialogs.close(); return selectTask(task.taskId); }));
    }
    if (!client.state.projectId || !query) return;
    pending = new AbortController();
    try {
      const data = await request(`${projectPath(client.state.projectId)}/search?${new URLSearchParams({ q: search.value })}`, { signal: pending.signal });
      if (current !== generation || selectedDialog !== dialogs.generation) return;
      for (const result of data.results) results.append(button(`${result.path}:${result.line}  ${result.text}`, () => {
        dialogs.close();
        if (filesOnly) composer.reference(fileReference(result.path, result.line));
        else { void showView("files").then(() => files.open(result.path, result.line)); }
      }));
      if (data.truncated) results.append(note("Search results are truncated.", "warn"));
    } catch (error) { if (current === generation && error.name !== "AbortError" && selectedDialog === dialogs.generation) results.append(note(error.message, "bad")); }
  };
  search.oninput = () => { void paint(); };
  content.onkeydown = (event) => {
    const items = [...results.querySelectorAll("button")];
    if (["ArrowDown", "ArrowUp"].includes(event.key) && items.length) {
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    }
    if (event.key === "Enter" && document.activeElement === search) { event.preventDefault(); items[0]?.click(); }
  };
  void paint();
}

async function onboarding() {
  const overlay = el("onboarding");
  if (overlay.open) return;
  overlay.showModal();
  const status = el("onboarding-status");
  status.replaceChildren();
  el("ob-key").value = "";
  const preferred = routedModels(settings?.config)[0];
  el("ob-base").value = preferred?.baseUrl ?? "";
  el("ob-model").value = preferred?.modelName ?? "";
  el("ob-protocol").value = preferred?.protocol ?? "openai-chat";
  el("ob-images").checked = preferred?.multimodal === true;
  const nativeConfig = await request("/desktop/config").catch(() => null);
  const values = () => ({
    baseUrl: el("ob-base").value, modelName: el("ob-model").value, protocol: el("ob-protocol").value,
    multimodal: el("ob-images").checked,
    ...(el("ob-key").value ? { apiKey: el("ob-key").value } : {}),
    ...(nativeConfig?.revision ? { revision: nativeConfig.revision } : {}),
  });
  el("ob-test").onclick = async () => {
    el("ob-test").disabled = true;
    try {
      const result = await request("/desktop/config/test", post(values()));
      status.replaceChildren(note(result.ok ? "Connection successful." : result.error ?? "Connection failed.", result.ok ? "ok" : "bad"));
    } catch (error) { status.replaceChildren(note(error.message, "bad")); }
    finally { el("ob-test").disabled = false; }
  };
  el("ob-generate").onclick = async () => {
    el("ob-generate").disabled = true;
    try {
      const result = await request("/desktop/config/generate", post(values()));
      status.replaceChildren(note(result.ok ? "Generation check completed." : result.error ?? "Probe failed.", result.ok ? "ok" : "bad"));
    } catch (error) { status.replaceChildren(note(error.message, "bad")); }
    finally { el("ob-generate").disabled = false; }
  };
  el("onboarding-form").onsubmit = async (event) => {
    event.preventDefault(); el("ob-save").disabled = true;
    try {
      const result = await request("/desktop/config/save", post(values()));
      el("ob-key").value = ""; overlay.close();
      settings = await request("/v1/settings"); presentation(settings.presentation); composer.refresh();
      mountedView = ""; render();
      await client.refreshLists();
      notify(result.warning ?? tr("Model configuration saved."));
    } catch (error) { status.replaceChildren(note(error.message, "bad")); }
    finally { el("ob-save").disabled = false; }
  };
  el("ob-later").onclick = () => { el("ob-key").value = ""; overlay.close(); };
  overlay.oncancel = () => { el("ob-key").value = ""; };
}

el("project-select").onchange = () => { void selectProject(el("project-select").value); };
el("task-select").onchange = () => { void selectTask(el("task-select").value); };
el("task-filter").oninput = renderNavigation;
el("add-project").onclick = () => { void addProject(); };
el("project-manage").onclick = () => { void manageProject(); };
el("new-task").onclick = () => { void selectTask(null).then(() => composer.newTask()); };
el("workspace-files").onclick = () => { void showView("files"); closeDrawers(); };
for (const id of ["settings-button", "sidebar-settings"]) el(id).onclick = () => { void showView("settings"); closeDrawers(); };
for (const item of el("workspace-tabs").querySelectorAll("button")) item.onclick = () => { void showView(item.dataset.view); };
el("command-button").onclick = () => commandPalette();
el("pending-button").onclick = () => { setPanel("inspector", true); el("decisions").scrollIntoView({ block: "nearest" }); };
el("refresh").onclick = async () => { await client.refreshLists(); await client.reconnect(); };
for (const kind of ["pause", "stop"]) el(kind).onclick = async () => {
  const taskId = client.state.taskId;
  try {
    const result = await request(`${taskPath(taskId)}/control`, post({ kind }));
    notify(tr(result.queued ? "Control queued; it applies at the next safe boundary." : "Control recorded."));
    if (taskId === client.state.taskId) await client.reconnect();
  } catch (error) { notify(error.message, true); }
};
el("export-proof").onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(client.state.proof, null, 2)], { type: "application/json" }));
  node("a", { href: url, download: `${client.state.taskId}.proof.json` }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el("modal").open && !el("onboarding").open) { closeDrawers(); el("command-button").focus(); }
  if (el("onboarding").open || el("modal").open) return;
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLocaleLowerCase() === "k") { event.preventDefault(); commandPalette(); }
  if (event.key === ",") { event.preventDefault(); void showView("settings"); }
  if (event.key === "Enter") { event.preventDefault(); composer.submit(); }
  if (event.key.toLocaleLowerCase() === "p") { event.preventDefault(); commandPalette(true); }
});
window.addEventListener("keystone:settings", () => { void showView("settings"); });

function mountComposer() { return createComposer(el("composer-host"), {
  client, request, drafts, dialogs, getSettings: () => settings, getEgress: () => capabilities.egress ?? [], referencePicker: () => commandPalette(true),
  async afterStart(taskId, projectId) {
    await client.refreshLists();
    if (client.state.projectId === projectId) await selectTask(taskId);
  },
}); }
composer = mountComposer();
client.subscribe(render);
restorePanels(); render();

async function main() {
  shell = await request("/desktop/bootstrap").catch(() => null);
  if (!token && !shell) {
    el("error").hidden = false;
    el("error").textContent = tr("No token in the URL. Open the URL printed by `keystone serve`, which includes the token fragment.");
    return;
  }
  ready = true;
  try {
    capabilities = await request("/v1/capabilities");
    settings = await request("/v1/settings");
    presentation(settings.presentation); composer.refresh();
  } catch (error) { notify(error.message, true); }
  await client.refreshLists();
  const stored = localGet("keystone.project");
  const project = client.state.projects.find((entry) => entry.projectId === stored) ?? client.state.projects.find((entry) => !entry.archived);
  if (project) await selectProject(project.projectId);
  if (shell?.hasModel === false) await onboarding();
}
let tickBusy = false;
async function tick() {
  if (disposed || !ready || document.hidden || navigator.onLine === false || tickBusy) return;
  tickBusy = true;
  try { await Promise.all([client.refreshLists(), client.poll()]); }
  finally { tickBusy = false; }
}
const timer = setInterval(() => { void tick(); }, 2500);
document.addEventListener("visibilitychange", () => { client.setVisible(!document.hidden && navigator.onLine !== false); if (!document.hidden) void tick(); });
window.addEventListener("online", () => { client.setVisible(!document.hidden); void tick(); });
window.addEventListener("offline", () => client.setVisible(false));
window.addEventListener("pagehide", () => {
  disposed = true; clearInterval(timer); composer.dispose(); mounted?.dispose?.(); files.dispose(); client.dispose(); diffController?.abort();
});
await main();
