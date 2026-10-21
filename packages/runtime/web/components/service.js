import { button, jsonDetails, node, note, tr } from "./dom.js";
import { createResource } from "../state/resource.js";

export const unwrap = (value) => value?.data ?? value;
export function collection(value, ...keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
    if (Array.isArray(value?.[key]?.entries)) return value[key].entries;
  }
  return null;
}
export function unavailable(error) {
  const unsupported = [404, 405, 501, 503].includes(error?.status);
  return node("div", { class: "service-error", role: "alert" }, [
    note(unsupported ? "This capability is unavailable from the local service." : "The request failed. No change is confirmed.", "bad"),
    node("p", { text: error?.message ?? tr("Unknown") }),
    ...(error?.body ? [jsonDetails("Service refusal", error.body)] : []),
  ]);
}
export function projectionDetails(value) {
  const source = value?.source ?? value?.provenance;
  const scope = value?.scope ?? value?.subjects;
  const dependencies = value?.dependencies ?? value?.derivedFrom;
  const printable = (item) => typeof item === "string" ? item : Array.isArray(item) ? item.map(printable).join(", ") : JSON.stringify(item);
  const fields = [
    ["Source", source?.locator ?? source?.source ?? (typeof source === "string" ? source : null)],
    ["Trust level", source?.trustLevel ?? source?.trust ?? value?.trustLevel],
    ["Scope", scope], ["Dependencies", dependencies],
    ["Updated", value?.updatedAt ?? value?.observedAt ?? value?.createdAt],
  ].filter(([, item]) => item != null && item !== "" && (!Array.isArray(item) || item.length));
  return node("div", { class: "projection-details" }, [
    ...(fields.length ? [node("dl", { class: "projection-metadata" }, fields.map(([label, item]) => node("div", {}, [
      node("dt", { text: tr(label) }), node("dd", { text: printable(item) }),
    ])))] : []),
    jsonDetails("Source, scope and provenance", value),
  ]);
}
export function emptyProjection(host, data, rows, message) {
  if (rows === null) host.append(note("The service returned an unrecognized projection. Inspect the response; no records are inferred.", "warn"));
  else if (!rows.length) host.append(note(message));
  if (data) host.append(jsonDetails("Service response", data));
}
export function downloadJson(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  node("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Common request/error shell; each page owns its domain actions and projection. */
export function servicePage(host, { title, description, path, request, render }) {
  const status = node("div", { role: "status", "aria-live": "polite" });
  const body = node("div", { class: "service-body" });
  const controls = node("div", { class: "service-controls" });
  const actions = node("div", { class: "row" });
  const refresh = button("Refresh", () => resource.load());
  actions.append(refresh);
  host.replaceChildren(node("div", { class: "service-page" }, [
    node("div", { class: "service-heading" }, [
      node("div", {}, [node("h2", { text: tr(title) }), node("p", { class: "muted", text: tr(description) })]), actions,
    ]), status, controls, body,
  ]));
  const resource = createResource({ path, request, onChange(state) {
    refresh.disabled = state.loading || state.busy;
    status.replaceChildren();
    if (state.loading) status.append(note("Loading service projection"));
    if (state.busy) status.append(note("Waiting for the local service"));
    if (state.stale) status.append(note("Showing last known data. Reconnect before relying on it.", "warn"));
    if (state.error) status.append(unavailable(state.error));
    if (state.result && state.error) status.append(jsonDetails("Acknowledged service result; projection refresh failed", state.result));
    render(body, state, resource);
  } });
  return { resource, actions, controls, body, load: () => resource.load(), dispose: () => resource.dispose() };
}
