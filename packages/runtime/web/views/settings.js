import { node, button, field, selectField, tr, note, jsonDetails, localGet, localSet, bytes } from "../components/dom.js";
import { post } from "../client/api.js";

const PAGES = [
  ["appearance", "General and appearance"], ["models", "Models and routing"], ["workspace", "Project and workspace"],
  ["rights", "Execution and permissions"], ["context", "Context and cognition"], ["data", "Data and storage"],
  ["privacy", "Privacy and egress"], ["notifications", "Notifications and background"],
];
const PROTOCOLS = [
  ["openai-chat", "OpenAI Chat"], ["openai-responses", "OpenAI Responses"],
  ["anthropic-messages", "Anthropic Messages"], ["gemini-generate", "Gemini Generate"],
];
const copy = (value) => JSON.parse(JSON.stringify(value));

export function createSettingsView(host, { request, dialogs, state, capabilities, onPresentation, onSaved, shell, openNativeConfiguration }) {
  let disposed = false;
  let settings = null;
  let draft = null;
  let presentation = null;
  let page = "appearance";
  let dirty = false;
  let inventory = null;
  let editVersion = 0;
  let loadVersion = 0;
  let pageVersion = 0;
  let loading = null;
  let saving = false;
  const nav = node("nav", { class: "settings-navigation", "aria-label": tr("Settings pages") });
  const content = node("div", { class: "settings-section" });
  const status = node("div", { role: "status", "aria-live": "polite" });
  const save = button("Save and apply", async () => {
    if (!draft || !settings || saving) return;
    saving = true; save.disabled = true;
    const selectedVersion = editVersion;
    const config = copy(draft);
    try {
      for (const model of config.models) {
        if (model.baseUrl) model.endpointHost = new URL(model.baseUrl).host;
      }
      const saved = await request("/v1/settings", post({ revision: settings.revision, config, presentation: copy(presentation) }));
      await onSaved(saved);
      if (disposed) return;
      settings = saved;
      if (selectedVersion === editVersion) {
        draft = copy(saved.config); presentation = copy(saved.presentation); dirty = false;
      }
      onPresentation(presentation);
      status.replaceChildren(note(dirty ? "Saved revision; newer draft edits remain unsaved." : "Saved. Active tasks retain their configuration snapshot; new tasks use this revision.", "ok"));
      if (!disposed) render();
    } catch (error) {
      status.replaceChildren(note(error.status === 409 ? "Settings changed elsewhere. Your draft is preserved; reload explicitly before retrying." : error.message, "bad"));
    } finally { saving = false; if (!disposed) save.disabled = !dirty; }
  }, "primary");
  const reload = button("Reload settings", async () => {
    if (dirty && !(await dialogs.confirm("Discard settings draft", note("Reload discards only unsaved settings changes."), "Reload settings", true))) return;
    await load();
  });
  host.replaceChildren(node("div", { class: "settings-view" }, [
    node("div", { class: "settings-layout" }, [nav, content]),
    node("div", { class: "settings-savebar" }, [status, node("div", { class: "row" }, [reload, save])]),
  ]));
  const changed = () => { editVersion += 1; dirty = true; save.disabled = saving; };
  async function load() {
    if (saving) return;
    loading?.abort(); loading = new AbortController();
    const signal = loading.signal;
    const selectedVersion = ++loadVersion;
    const selectedEdit = editVersion;
    try {
      const result = await request("/v1/settings", { signal });
      if (disposed || signal.aborted || selectedVersion !== loadVersion) return;
      if (selectedEdit !== editVersion) { status.replaceChildren(note("Settings loaded after a newer edit. Your draft is retained; reload explicitly.", "warn")); return; }
      settings = result; draft = copy(result.config); presentation = copy(result.presentation); dirty = false;
      onPresentation(presentation); save.disabled = true;
      status.replaceChildren(); render();
    } catch (error) { if (!disposed && !signal.aborted) status.replaceChildren(note(error.message, "bad")); }
  }
  function render() {
    if (disposed || !settings) return;
    pageVersion += 1;
    nav.replaceChildren();
    for (const [id, label] of PAGES) {
      const item = button(label, () => { page = id; render(); }, `nav-item ${page === id ? "active" : ""}`);
      if (page === id) item.setAttribute("aria-current", "page");
      nav.append(item);
    }
    content.replaceChildren(node("h3", { text: tr(PAGES.find(([id]) => id === page)[1]) }));
    content.append(node("div", { class: "settings-source" }, [
      node("p", { class: "muted", text: tr("Global revision {revision}. Project/task constraints may only narrow this scope.", { revision: settings.revision }) }),
      jsonDetails("Source and effective configuration", { source: settings.source, effective: settings.effective }),
    ]));
    if (page === "appearance") appearance();
    if (page === "models") models();
    if (page === "workspace") workspace();
    if (page === "rights") rights();
    if (page === "context") context();
    if (page === "privacy") privacy();
    if (page === "notifications") notifications();
    if (page === "data") void data(pageVersion);
  }
  function appearance() {
    const theme = selectField("Theme", "settings-theme", [["system", "Follow system"], ["light", "Light"], ["dark", "Dark"]], presentation.theme);
    theme.wrap.className = "field sr-only";
    const tiles = node("div", { class: "theme-tiles", role: "group", "aria-label": tr("Theme") });
    const paintTiles = () => {
      for (const item of tiles.querySelectorAll("button")) item.setAttribute("aria-pressed", String(item.getAttribute("data-theme-choice") === presentation.theme));
    };
    for (const [value, label] of [["light", "Light"], ["dark", "Dark"], ["system", "Follow system"]]) {
      const tile = button(label, () => {
        presentation.theme = value; theme.input.value = value;
        onPresentation(presentation); changed(); paintTiles();
      }, `theme-tile theme-${value}`);
      tile.setAttribute("data-theme-choice", value);
      tile.prepend(node("span", { class: "theme-preview", "aria-hidden": "true" }, [
        node("span", { class: "theme-preview-sidebar" }), node("span", { class: "theme-preview-content" }),
      ]));
      tiles.append(tile);
    }
    paintTiles();
    const density = selectField("Density", "settings-density", [["comfortable", "Comfortable"], ["compact", "Compact"]], presentation.density);
    const language = selectField("Language", "settings-language", [["zh-CN", "Chinese"], ["en", "English"]], draft.language ?? globalThis.KEYSTONE_LANG ?? "zh-CN");
    theme.input.onchange = () => { presentation.theme = theme.input.value; onPresentation(presentation); changed(); paintTiles(); };
    density.input.onchange = () => { presentation.density = density.input.value; onPresentation(presentation); changed(); };
    language.input.onchange = () => { draft.language = language.input.value; changed(); };
    content.append(node("h4", { text: tr("Theme") }), tiles, theme.wrap, node("div", { class: "settings-rows" }, [language.wrap, density.wrap]));
    content.append(note("Language applies after saving. Theme and density preview immediately."));
    content.append(jsonDetails("Keyboard shortcuts", {
      "Cmd/Ctrl+K": tr("Command palette"), "Cmd/Ctrl+,": tr("Settings"), "Cmd/Ctrl+Enter": tr("Submit"),
      Escape: tr("Close dialogs and drawers"), "Arrow keys": tr("Resize focused separators"),
    }));
  }
  function modelInput(entry, label, key, type = "text", immutable = false) {
    const item = field(label, `model-${entry.id}-${key}`, entry[key] ?? "", type);
    item.input.readOnly = immutable;
    item.input.oninput = () => {
      if (key === "contextTokens") {
        if (item.input.value) entry[key] = Number(item.input.value); else delete entry[key];
      } else {
        if (item.input.value) entry[key] = item.input.value; else delete entry[key];
      }
      changed();
    };
    if (type === "number") item.input.min = "1";
    return item.wrap;
  }
  function models() {
    content.append(note("Discovery and generation send real requests only when clicked. Save a model before probing it."));
    if (shell && openNativeConfiguration) content.append(button("Configure model and credential", openNativeConfiguration));
    content.append(button("Add model", () => {
      draft.models.push({ id: `model-${crypto.randomUUID().slice(0, 8)}`, kind: "local", provider: "custom", modelName: "", protocol: "openai-chat", baseUrl: "", endpointHost: "", enabled: true });
      changed(); render();
    }));
    for (const entry of draft.models) {
      const section = node("div", { class: "model-entry" });
      const kind = selectField("Location", `kind-${entry.id}`, [["local", "Local"], ["cloud", "Cloud"]], entry.kind);
      kind.input.onchange = () => { entry.kind = kind.input.value; changed(); };
      const protocol = selectField("Protocol", `protocol-${entry.id}`, PROTOCOLS, entry.protocol ?? "openai-chat");
      protocol.input.onchange = () => { entry.protocol = protocol.input.value; changed(); };
      const enabled = node("input", { type: "checkbox", id: `enabled-${entry.id}` }); enabled.checked = entry.enabled;
      enabled.onchange = () => { entry.enabled = enabled.checked; changed(); };
      const multimodal = node("input", { type: "checkbox", id: `image-${entry.id}` }); multimodal.checked = entry.multimodal === true;
      multimodal.onchange = () => { entry.multimodal = multimodal.checked; changed(); };
      section.append(node("h4", { text: entry.modelName || entry.id }));
      section.append(node("div", { class: "form-columns" }, [
        modelInput(entry, "Stable model ID", "id", "text", true), modelInput(entry, "Model name", "modelName"),
        kind.wrap, protocol.wrap, modelInput(entry, "Provider", "provider"), modelInput(entry, "Base URL", "baseUrl", "url"),
        modelInput(entry, "Credential handle (not a secret)", "credentialHandle"), modelInput(entry, "Context tokens", "contextTokens", "number"),
      ]));
      section.append(node("div", { class: "field inline" }, [enabled, node("label", { for: enabled.id, text: tr("Enabled") })]));
      section.append(node("div", { class: "field inline" }, [multimodal, node("label", { for: multimodal.id, text: tr("Declare image input support") })]));
      section.append(note("Capability declarations are not independent verification. Every fallback must support the requested input."));
      const probeStatus = node("div", { role: "status", "aria-live": "polite" });
      const actions = node("div", { class: "row" });
      for (const [kindValue, label] of [["discovery", "Discover models"], ["generation", "Generation check"]]) {
        const probe = button(label, async (event) => {
          const entryButton = event.currentTarget;
          if (dirty) { probeStatus.replaceChildren(note("Save settings before probing.", "warn")); return; }
          if (!(await dialogs.confirm("Real provider request", node("div", {}, [note("This sends a real request to the configured endpoint and may incur usage."), jsonDetails("Request target", { id: entry.id, endpoint: entry.baseUrl, protocol: entry.protocol, kind: kindValue })]), label))) return;
          entryButton.disabled = true;
          try {
            const result = await request("/v1/settings/probe", post({ id: entry.id, kind: kindValue }));
            probeStatus.replaceChildren(note(result.ok ? "Probe completed; inspect the actual result below." : "Probe failed.", result.ok ? "ok" : "bad"), jsonDetails("Provider result", result));
          } catch (error) { probeStatus.replaceChildren(note(error.message, "bad")); }
          finally { entryButton.disabled = false; }
        });
        actions.append(probe);
      }
      actions.append(button("Remove model", async () => {
        if (!(await dialogs.confirm("Remove model", note("Removal affects future routes, not active task snapshots."), "Remove model", true))) return;
        draft.models = draft.models.filter((item) => item.id !== entry.id);
        for (const ids of Object.values(draft.routes ?? {})) {
          const index = ids.indexOf(entry.id); if (index !== -1) ids.splice(index, 1);
        }
        changed(); render();
      }, "danger"));
      section.append(actions, probeStatus); content.append(section);
    }
    content.append(node("h3", { text: tr("Role routes and ordered fallbacks") }));
    for (const role of ["builder", "planner", "summarizer"]) {
      const route = field(tr("{role} model IDs, in order", { role }), `route-${role}`, (draft.routes?.[role] ?? []).join(", "));
      route.input.oninput = () => { draft.routes ??= {}; draft.routes[role] = route.input.value.split(",").map((value) => value.trim()).filter(Boolean); changed(); };
      content.append(route.wrap);
    }
    content.append(note("An empty route uses enabled models in configuration order. Local-to-cloud fallback is never inferred by this UI."));
  }
  function workspace() {
    const project = state.projects.find((entry) => entry.projectId === state.projectId);
    content.append(jsonDetails("Current project", project ?? null));
    content.append(note("Project metadata is managed from navigation. Removing a project removes its registry entry, never its code."));
    content.append(note("One writer per workspace. Unknown commands need explicit confirmation; task permissions are not expanded by these settings."));
  }
  function rights() {
    content.append(note("Default deny. Actual permissions and capability leases belong to the kernel, not presentation preferences."));
    const confirmAll = node("input", { id: "settings-confirm-all", type: "checkbox" });
    confirmAll.checked = localGet("keystone.confirmAllWrites") === "1";
    confirmAll.onchange = () => localSet("keystone.confirmAllWrites", confirmAll.checked ? "1" : "0");
    content.append(node("div", { class: "field inline" }, [confirmAll, node("label", { for: confirmAll.id, text: tr("Confirm every write task (never auto-start)") })]));
    content.append(note("This confirmation preference is local to this browser and can only tighten submission."));
    draft.defaults ??= {};
    for (const [key, label, min] of [["maxTokens", "Token budget", 1], ["maxWallClockMs", "Time budget (ms)", 1], ["maxRetries", "Retry budget", 0], ["maxCostUsd", "Cost budget (USD)", 0]]) {
      const setting = field(label, `budget-${key}`, draft.defaults[key] ?? "", "number");
      setting.input.min = String(min);
      if (key === "maxCostUsd") setting.input.step = "0.01";
      setting.input.oninput = () => { if (setting.input.value) draft.defaults[key] = Number(setting.input.value); else delete draft.defaults[key]; changed(); };
      content.append(setting.wrap);
    }
    content.append(jsonDetails("Current task autonomy envelope", state.detail?.contract?.autonomy ?? null));
  }
  function context() {
    const plans = state.events.filter((event) => event.type === "context.plan_created");
    content.append(note("Candidate experience is quarantined. Frozen rules and provenance cannot be replaced by client preferences."));
    content.append(jsonDetails("Current context plan", plans.at(-1)?.payload ?? null));
    content.append(jsonDetails("Learning projection", state.run?.learning ?? null));
  }
  function privacy() {
    content.append(note("Attachments are imported locally. Submitting may send selected content to explicitly configured model endpoints."));
    content.append(jsonDetails("Runtime egress", capabilities.egress ?? null));
    content.append(jsonDetails("Configured destinations", draft.models.map(({ id, kind, baseUrl, endpointHost, protocol, multimodal }) => ({ id, kind, baseUrl, endpointHost, protocol, multimodal }))));
    content.append(note("Credential handles are references. Secrets are never returned by the settings API or included in exported proof."));
    if (shell) content.append(note("Use native onboarding to enter a secret. Web settings accept credential handles only."));
    content.append(note("No telemetry or diagnostic upload is enabled by this workbench."));
  }
  function notifications() {
    const preference = node("input", { type: "checkbox", id: "notify-local" });
    preference.checked = localGet("keystone.notifications") === "1";
    preference.onchange = async () => {
      if (preference.checked && globalThis.Notification) {
        const result = await Notification.requestPermission();
        if (result !== "granted") preference.checked = false;
      } else if (preference.checked) preference.checked = false;
      localSet("keystone.notifications", preference.checked ? "1" : "0");
    };
    content.append(node("div", { class: "field inline" }, [preference, node("label", { for: preference.id, text: tr("Notify about completion and decisions in this browser") })]));
    content.append(note("Browser preference only. Native background and window-close policies are controlled by the native carrier; this page does not change them."));
    content.append(jsonDetails("Native carrier", shell ? { configured: shell.hasModel, capabilities: shell.capabilities ?? null } : { available: false }));
  }
  async function data(selectedVersion) {
    const target = content;
    target.append(note("Inventory and operations concern Keystone data, never repository deletion. Only rebuildable cache cleanup is offered."));
    try {
      inventory = await request("/v1/data");
      if (disposed || page !== "data" || selectedVersion !== pageVersion) return;
      target.append(node("p", { class: "muted", text: `${tr("Data root")}: ${inventory.home ?? inventory.rootPath ?? tr("Unknown")}` }));
      const table = node("table", { class: "inventory" });
      const header = node("tr", {}, ["Category", "Size"].map((key) => node("th", { text: tr(key), scope: "col" })));
      table.append(node("thead", {}, header));
      const rows = node("tbody");
      const categories = inventory.categories ?? [
        { category: "Projects", bytes: (inventory.projects ?? []).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) },
        { category: "Tasks", bytes: (inventory.tasks ?? []).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) },
        { category: "Attachments", ...inventory.attachments }, { category: "Settings", ...inventory.settings },
        { category: "Task history", ...inventory.history }, { category: "Credentials", ...inventory.credentials },
        { category: "Artifacts", ...inventory.artifacts }, { category: "Cache", ...inventory.derived?.cache },
        { category: "Index", ...inventory.derived?.index }, { category: "Proof", ...inventory.derived?.proofs },
        { category: "Total", ...inventory.totals },
      ];
      for (const category of categories) rows.append(node("tr", {}, [node("td", { text: tr(category.category ?? category.name) }), node("td", { text: bytes(category.bytes ?? category.size ?? 0) })]));
      table.append(rows); target.append(table, note("Attachment and history categories overlap stored artifacts and tasks; Total is the actual store size."), jsonDetails("Inventory and dependencies", inventory));
      const resultHost = node("div", { role: "status", "aria-live": "polite" });
      const failed = (error) => {
        if (!disposed && selectedVersion === pageVersion) resultHost.replaceChildren(note(error.message, "bad"), jsonDetails("Refusal and impact", error.body ?? {}));
      };
      const cleanup = button("Preview cache cleanup", async () => {
        try {
          const preview = await request("/v1/data/cleanup", post({ category: "cache", preview: true }));
          if (disposed || selectedVersion !== pageVersion) return;
          resultHost.replaceChildren(jsonDetails("Cleanup preview", preview));
          if (!(await dialogs.confirm("Clean rebuildable cache", jsonDetails("Impact and retained data", preview), "Clean cache", true))) return;
          if (disposed || selectedVersion !== pageVersion) return;
          const result = await request("/v1/data/cleanup", post({ category: "cache", preview: false }));
          if (!disposed) resultHost.replaceChildren(jsonDetails("Cleanup result", result));
        } catch (error) { failed(error); }
      });
      const destination = field("Migration destination", "data-destination");
      const migrate = button("Preview migration", async () => {
        if (!destination.input.value.trim()) { destination.input.focus(); return; }
        const path = destination.input.value.trim();
        try {
          const preview = await request("/v1/data/migrate", post({ destination: path, preview: true }));
          if (disposed || selectedVersion !== pageVersion) return;
          resultHost.replaceChildren(jsonDetails("Migration preview", preview));
          if (!(await dialogs.confirm("Migrate local data", node("div", {}, [note("Data is copied, verified and switched. The source is retained for recovery."), jsonDetails("Impact", preview)]), "Migrate data"))) return;
          if (disposed || selectedVersion !== pageVersion) return;
          const result = await request("/v1/data/migrate", post({ destination: path, preview: false }));
          if (!disposed) resultHost.replaceChildren(jsonDetails("Migration result", result));
        } catch (error) { failed(error); }
      });
      target.append(node("div", { class: "row" }, [cleanup, button("Export inventory", () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(inventory, null, 2)], { type: "application/json" }));
        const link = node("a", { href: url, download: "keystone-inventory.json" }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      })]), destination.wrap, migrate, resultHost);
    } catch (error) { if (!disposed && page === "data" && selectedVersion === pageVersion) target.append(note(error.message, "bad")); }
  }
  save.disabled = true; void load();
  return { dispose() { disposed = true; loading?.abort(); }, get dirty() { return dirty; }, get saving() { return saving; } };
}
