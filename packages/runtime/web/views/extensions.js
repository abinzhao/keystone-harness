import { button, field, jsonDetails, node, note, tr } from "../components/dom.js";
import { collection, emptyProjection, projectionDetails, servicePage, unwrap } from "../components/service.js";
import { post } from "../client/api.js";
import { createModelPluginView } from "./model-plugin.js";

export function createExtensionsView(host, { request, dialogs, onModelEnabled }) {
  let tab = "installed";
  let review = null;
  let reviewDirectory = "";
  let reviewVersion = 0;
  let disposed = false;
  const reviewHost = node("div", { class: "extension-review", role: "status", "aria-live": "polite" });
  const directory = field("Local extension directory", "extension-directory");
  const reviewButton = button("Review directory", async () => {
    if (!directory.input.value.trim() || page.resource.state.busy || disposed) { directory.input.focus(); return; }
    const selected = ++reviewVersion;
    const path = directory.input.value.trim();
    reviewButton.disabled = true; install.disabled = true; review = null;
    reviewHost.replaceChildren(note("Reviewing manifest, integrity and requested permissions"));
    try {
      const result = await request("/v1/extensions/review", post({ directory: path }));
      if (disposed || selected !== reviewVersion || path !== directory.input.value.trim()) return;
      review = unwrap(result)?.review ?? unwrap(result); reviewDirectory = path;
      reviewHost.replaceChildren(projectionDetails(review));
      if (review?.upgrade) {
        const upgrade = review.upgrade;
        reviewHost.prepend(node("div", { class: "upgrade-summary" }, [
          node("h3", { text: tr("Upgrade review") }),
          node("p", { text: `${upgrade.fromVersion ?? tr("Unknown")} → ${upgrade.toVersion ?? tr("Unknown")}` }),
          node("p", { class: "muted", text: tr(upgrade.permissionsChanged ? "Permission declarations changed." : "Permission declarations unchanged.") }),
          node("p", { text: `${tr("Changed files")}: ${(upgrade.changedFiles ?? []).join(", ") || tr("none")}` }),
          node("p", { text: `${tr("Added capabilities")}: ${(upgrade.addedCapabilities ?? []).join(", ") || tr("none")}` }),
          node("p", { text: `${tr("Removed capabilities")}: ${(upgrade.removedCapabilities ?? []).join(", ") || tr("none")}` }),
        ]));
      }
      if (review?.blockers?.length || review?.staticChecksPassed === false) {
        reviewHost.append(note("Static review has blocking failures. Installation is unavailable.", "bad"));
        review = null;
      } else if (review?.error || review?.supported === false || typeof review?.reviewHash !== "string" || !review.reviewHash) {
        review = null;
        reviewHost.append(note("The review has no usable hash. Installation is unavailable.", "warn"));
      }
    } catch (error) {
      if (!disposed && selected === reviewVersion) reviewHost.replaceChildren(note(error.message, "bad"), jsonDetails("Service refusal", error.body ?? {}));
    } finally {
      if (!disposed && selected === reviewVersion) { reviewButton.disabled = false; install.disabled = !review; }
    }
  });
  const install = button("Install reviewed extension", async () => {
    if (!review || disposed || page.resource.state.busy || reviewDirectory !== directory.input.value.trim()) return;
    const selected = reviewVersion;
    const input = { directory: reviewDirectory, reviewHash: review.reviewHash, confirmed: true };
    if (!(await dialogs.confirm("Install extension", node("div", {}, [
      note("Review the exact version, content hash and permissions. Installation does not grant execution capabilities."),
      projectionDetails(review), jsonDetails("Installation request", input),
    ]), "Install reviewed extension"))) return;
    if (disposed || selected !== reviewVersion || reviewDirectory !== directory.input.value.trim()) return;
    install.disabled = true;
    const result = await page.resource.mutate("/v1/extensions/install", post(input));
    if (disposed) return;
    if (result) { review = null; reviewVersion += 1; reviewHost.replaceChildren(jsonDetails("Installation result", result)); }
    install.disabled = !review;
  }, "primary");
  install.disabled = true;
  directory.input.addEventListener("input", () => {
    reviewVersion += 1; review = null; reviewDirectory = "";
    install.disabled = true; reviewButton.disabled = false; reviewHost.replaceChildren();
  });
  const tabs = node("nav", { class: "segmented", "aria-label": tr("Extension lists") });
  const installed = button("Installed", () => { tab = "installed"; paint(); });
  const discovery = button("Discovery", () => { tab = "discovery"; paint(); });
  tabs.append(installed, discovery);
  const page = servicePage(host, {
    title: "Extensions", description: "Review, install and manage local extensions without expanding the kernel's permissions.",
    path: "/v1/extensions", request,
    render(body, state) {
      body.replaceChildren(); installed.setAttribute("aria-pressed", String(tab === "installed")); discovery.setAttribute("aria-pressed", String(tab === "discovery"));
      const data = unwrap(state.data);
      if (!data) return;
      const rows = tab === "installed" ? collection(data, "extensions", "installed", "entries") : collection(data, "discovery", "available", "catalog");
      for (const entry of rows ?? []) {
        const manifest = entry.manifest ?? entry;
        const name = manifest.name ?? entry.name;
        const item = node("article", { class: "extension-row" }, [
          node("div", { class: "extension-symbol", "aria-hidden": "true", text: (name ?? "?").slice(0, 1).toUpperCase() }),
          node("div", { class: "extension-description" }, [
            node("h3", { text: name ?? tr("Unknown") }),
            node("p", { class: "muted", text: manifest.description ?? entry.description ?? "" }),
            node("p", { class: "muted", text: [manifest.version, manifest.type ?? manifest.kind, entry.status ?? (entry.active === true ? tr("Active") : "")].filter(Boolean).join(" · ") }),
            projectionDetails(entry),
          ]),
        ]);
        const actions = node("div", { class: "row" });
        if (tab === "installed") {
          for (const [action, label] of [["probe", "Probe"], ["activate", "Activate"], ["disable", "Disable"], ["uninstall", "Uninstall"]]) {
            const bounded = action === "probe" || action === "activate";
            const reviewHash = entry.reviewHash;
            const control = button(label, async () => {
              if (disposed || page.resource.state.busy || (bounded && !reviewHash)) return;
              const input = { confirmed: true, ...(reviewHash ? { reviewHash } : {}) };
              if (!(await dialogs.confirm(label, node("div", {}, [
                note(action === "probe" ? "A probe may run extension code in its declared boundary. Review its manifest before continuing." : "The service enforces lifecycle and capability checks. Existing task evidence is retained."),
                projectionDetails(entry), jsonDetails("Requested change", { name, action, ...input }),
              ]), label, action === "uninstall"))) return;
              if (disposed || page.resource.state.busy || page.resource.state.stale) return;
              await page.resource.mutate(`/v1/extensions/${encodeURIComponent(name)}/${action}`, post(input));
            }, action === "uninstall" ? "danger" : "");
            control.disabled = !name || (bounded && !reviewHash) || state.loading || state.busy || state.stale;
            actions.append(control);
          }
          if (!entry.reviewHash) item.append(note("The installed review hash is unavailable. Review and reinstall before probing or activating.", "warn"));
        } else if (entry.directory) {
          actions.append(button("Review directory", () => {
            directory.input.value = entry.directory; reviewVersion += 1; review = null; install.disabled = true; reviewHost.replaceChildren();
            directory.input.focus(); directory.wrap.scrollIntoView?.({ block: "nearest" });
          }));
        } else item.append(note("No local directory is provided. Locate the source before requesting a review."));
        item.append(actions); body.append(item);
      }
      if (rows === null || !rows.length) emptyProjection(body, null, rows, tab === "installed" ? "No extensions installed." : "No discovery catalog is available from this service.");
      if (state.result) body.append(jsonDetails("Lifecycle result", state.result));
      body.append(jsonDetails("Service response", state.data));
    },
  });
  const paint = () => {
    // Changing list tabs reuses the known projection, not a synthesized catalog.
    page.resource.load();
  };
  const input = node("div", { class: "extension-install form-grid" }, [
    directory.wrap, node("div", { class: "row" }, [reviewButton, install]), reviewHost,
  ]);
  page.controls.append(tabs, input);
  const modelHost = node("div");
  const pluginSection = node("details", { class: "plugin-section", open: true }, [
    node("summary", { text: tr("TRAE CLI model") }), modelHost,
  ]);
  page.controls.prepend(pluginSection);
  const modelPlugin = createModelPluginView(modelHost, { request, dialogs, onEnabled: onModelEnabled });
  void page.load();
  return { dispose() { disposed = true; reviewVersion += 1; modelPlugin.dispose(); page.dispose(); } };
}
