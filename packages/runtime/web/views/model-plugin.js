import { button, field, jsonDetails, node, note, tr } from "../components/dom.js";
import { unavailable } from "../components/service.js";
import { post } from "../client/api.js";

const PATH = "/v1/model-plugins/trae-cli";
const PRIVATE_NETWORK_NOTE = "Default off. When enabled, only explicitly declared DNS hosts may resolve to RFC1918 enterprise private addresses. HTTPS with matching SNI on port 443 is still required; localhost and loopback remain blocked. Changing this option requires discovery and a new generation check.";

export function createModelPluginView(host, { request, dialogs, onEnabled = async () => {} }) {
  let disposed = false; let busy = false; let supported = false; let known = null;
  let discovered = ""; let checked = ""; let acknowledged = false;
  let privateNetworkRevision = 0;
  const path = field("CLI path (optional)", "trae-path");
  const endpoint = field("Model endpoint host", "trae-endpoint");
  const egress = field("Allowed egress hosts (comma separated)", "trae-egress");
  const privateNetwork = field("Allow enterprise private network", "trae-private-network", "", "checkbox");
  privateNetwork.input.checked = false;
  privateNetwork.input.setAttribute("aria-describedby", "trae-private-network-note");
  const model = node("select", { id: "trae-model", "aria-label": tr("TRAE CLI model") });
  const status = node("div", { role: "status", "aria-live": "polite" });
  const projection = node("div");
  const input = () => ({
    ...(path.input.value.trim() ? { cliPath: path.input.value.trim() } : {}),
    endpointHost: endpoint.input.value.trim(),
    egressHosts: [...new Set(egress.input.value.split(",").map((entry) => entry.trim()).filter(Boolean))],
    allowPrivateNetwork: privateNetwork.input.checked === true,
  });
  const signature = () => JSON.stringify(input());
  const probeSignature = () => JSON.stringify([signature(), model.value]);
  const validHost = (value) => {
    try { const url = new URL(`https://${value}`); return !!value && url.host === value && url.pathname === "/" && !url.username && !url.password; }
    catch { return false; }
  };
  const ready = () => {
    const value = input();
    return validHost(value.endpointHost) && value.egressHosts.length > 0
      && value.egressHosts.every(validHost) && value.egressHosts.includes(value.endpointHost);
  };
  function paint() {
    if (disposed) return;
    retry.disabled = busy;
    discover.disabled = busy || !supported;
    probe.disabled = busy || !supported || discovered !== signature() || !model.value;
    enable.disabled = busy || !supported || checked !== probeSignature() || !model.value || acknowledged;
    model.disabled = busy;
  }
  const retry = button("Retry plugin status", load);
  const discover = button("Discover CLI models", () => operation("discover"));
  const probe = button("Generation check", () => operation("probe"));
  const enable = button("Enable for new tasks", () => operation("enable"), "primary");
  for (const control of [path.input, endpoint.input, egress.input, model]) control.addEventListener("input", () => { acknowledged = false; paint(); });
  model.onchange = () => { acknowledged = false; paint(); };
  for (const event of ["input", "change"]) privateNetwork.input.addEventListener(event, () => {
    // A toggle back must not resurrect checks or confirmation of earlier consent.
    privateNetworkRevision += 1;
    discovered = ""; checked = ""; acknowledged = false; paint();
  });
  host.replaceChildren(node("div", { class: "model-plugin stack" }, [
    node("div", {}, [node("h3", { text: tr("TRAE CLI model") }), note("The CLI supplies model responses only. Repository tools and completion decisions remain in Keystone.")]),
    path.wrap, endpoint.wrap, egress.wrap,
    node("p", { id: "trae-private-network-note", class: "muted", text: tr(PRIVATE_NETWORK_NOTE) }),
    privateNetwork.wrap,
    node("p", { class: "muted", text: tr("Configure every destination explicitly. CLI login uses its native login flow; Keystone never asks for login secrets.") }),
    node("div", { class: "row" }, [retry, discover]),
    node("div", { class: "field" }, [node("label", { for: model.id, text: tr("Model for new tasks") }), model]),
    node("div", { class: "row" }, [probe, enable]), status, projection,
  ]));
  async function load() {
    if (disposed || busy) return;
    busy = true; paint(); status.replaceChildren(note("Loading plugin status; no discovery or generation is running."));
    try {
      const result = await request(PATH);
      if (disposed) return;
      known = result;
      supported = result.supported !== false && result.available !== false;
      if (result.cliPath && !path.input.value) path.input.value = result.cliPath;
      if (result.endpointHost && !endpoint.input.value) endpoint.input.value = result.endpointHost;
      if (result.egressHosts?.length && !egress.input.value) egress.input.value = result.egressHosts.join(", ");
      if (privateNetworkRevision === 0 && privateNetwork.input.checked !== (result.allowPrivateNetwork === true)) {
        privateNetwork.input.checked = result.allowPrivateNetwork === true;
        discovered = ""; checked = ""; acknowledged = false;
      }
      projection.replaceChildren(jsonDetails("Plugin status and isolation", result));
      status.replaceChildren(note(supported ? "Review CLI destinations, then explicitly discover and check a model." : "This CLI version or platform is unavailable. Inspect the compatibility result.", supported ? "" : "warn"));
    } catch (error) {
      if (!disposed) { supported = false; status.replaceChildren(unavailable(error)); }
    } finally { busy = false; paint(); }
  }
  async function operation(kind) {
    if (disposed || busy || !supported) return;
    if (!ready()) { status.replaceChildren(note("Enter an endpoint host and every allowed egress host before running CLI checks.", "warn")); endpoint.input.focus(); return; }
    if (kind !== "discover" && (!model.value || discovered !== signature())) return;
    if (kind === "enable" && checked !== probeSignature()) return;
    const captured = signature(); const selectedModel = model.value;
    const capturedRevision = privateNetworkRevision;
    const body = { ...input(), confirmed: true, ...(kind === "discover" ? {} : { modelId: selectedModel }) };
    const current = () => !disposed && capturedRevision === privateNetworkRevision
      && captured === signature() && (kind === "discover" || selectedModel === model.value);
    busy = true; paint();
    status.replaceChildren(note("Waiting for confirmation. No CLI process has been started."));
    try {
      const accepted = await dialogs.confirm(
        kind === "discover" ? "Discover CLI models" : kind === "probe" ? "Generation check" : "Enable for new tasks",
        node("div", { class: "stack" }, [
          note(kind === "discover" ? "Discovery starts an isolated CLI process and may contact the declared hosts."
            : kind === "probe" ? "This generation check sends a synthetic public prompt to the declared hosts and may incur usage."
            : "Enable this checked model for upcoming tasks only. Existing task snapshots and permissions are unchanged."),
          note(PRIVATE_NETWORK_NOTE),
          jsonDetails("Exact CLI operation and destinations", body), jsonDetails("Known isolation status", known),
        ]),
        kind === "enable" ? "Enable for new tasks" : "Run explicit check",
      );
      if (!accepted || !current()) {
        if (!disposed) status.replaceChildren(note("Cancelled or configuration changed. No operation was launched."));
        return;
      }
      status.replaceChildren(note("Waiting for the isolated CLI operation. No result is confirmed yet."));
      if (kind === "discover") { discovered = ""; checked = ""; }
      if (kind === "probe") checked = "";
      const result = await request(`${PATH}/${kind}`, { ...post(body), timeoutMs: 240000 });
      if (!current()) return;
      projection.replaceChildren(jsonDetails("CLI operation result", result));
      known = result;
      if (result.ok === false || result.supported === false || result.error) {
        if (kind === "probe") checked = "";
        status.replaceChildren(note(result.error?.message ?? result.error ?? result.reason ?? "CLI check failed. Inspect the compatibility result before retrying.", "bad"));
        return;
      }
      if (kind === "discover") {
        const rows = result.models ?? [];
        model.replaceChildren(...rows.map((entry) => node("option", {
          value: entry.id ?? entry.modelId, text: `${entry.name ?? entry.modelName ?? entry.id ?? entry.modelId}${entry.available === false ? ` · ${tr("Unavailable")}` : ""}`,
          disabled: entry.available === false,
        })));
        model.value = rows.find((entry) => entry.available !== false)?.id ?? rows.find((entry) => entry.available !== false)?.modelId ?? "";
        discovered = captured; checked = ""; acknowledged = false;
        status.replaceChildren(note(rows.length ? "Models discovered. Run a separate generation check before enabling." : "No CLI models were returned.", rows.length ? "ok" : "warn"));
      } else if (kind === "probe") {
        if (result.ok !== true) { status.replaceChildren(note("The service did not confirm a successful generation check.", "warn")); return; }
        checked = probeSignature();
        status.replaceChildren(note("Generation check passed. This does not prove engineering outcomes.", "ok"));
      } else {
        if (result.enabled !== true) { status.replaceChildren(note("The service did not confirm plugin activation.", "warn")); return; }
        acknowledged = true;
        status.replaceChildren(note("Plugin enabled for upcoming tasks. Existing task snapshots are unchanged.", "ok"));
        await onEnabled(result);
      }
    } catch (error) {
      if (current()) status.replaceChildren(unavailable(error), note("No automatic retry. Inspect status before repeating an uncertain operation.", "warn"));
    } finally { busy = false; paint(); }
  }
  paint(); void load();
  return { load, dispose() { disposed = true; } };
}
