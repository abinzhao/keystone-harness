export const tr = (key, params = {}) => (globalThis.KEYSTONE_I18N?.[key] ?? key)
  .replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
export const el = (id) => document.getElementById(id);
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
export const text = (key, params) => esc(tr(key, params));

export function node(tag, attrs = {}, children = []) {
  const value = document.createElement(tag);
  for (const [key, content] of Object.entries(attrs)) {
    if (key === "text") value.textContent = content;
    else if (key === "class") value.className = content;
    else if (key.startsWith("on")) value.addEventListener(key.slice(2), content);
    else if (content !== false && content != null) value.setAttribute(key, content === true ? "" : String(content));
  }
  for (const child of [children].flat()) if (child != null) value.append(child);
  return value;
}

export function button(label, onClick, className = "") {
  return node("button", { type: "button", text: tr(label), class: className, onclick: (event) => {
    Promise.resolve(onClick?.(event)).catch((error) => notify(error.message, true));
  } });
}

export function field(label, id, value = "", type = "text") {
  const input = node(type === "textarea" ? "textarea" : "input", { id, ...(type === "textarea" ? { rows: "3" } : { type }) });
  input.value = value;
  return { wrap: node("div", { class: type === "checkbox" ? "field checkbox-field" : "field" }, [node("label", { for: id, text: tr(label) }), input]), input };
}

export function selectField(label, id, values, selected) {
  const input = node("select", { id }, values.map((value) => node("option", { value: value[0], text: tr(value[1]) })));
  input.value = selected;
  return { wrap: node("div", { class: "field" }, [node("label", { for: id, text: tr(label) }), input]), input };
}

export const note = (message, tone = "") => node("div", { class: `notice ${tone}`, text: tr(message) });
export const jsonDetails = (label, value) => node("details", {}, [node("summary", { text: tr(label) }), node("pre", { text: JSON.stringify(value, null, 2) })]);
export const kv = (label, value) => `<div class="kv"><dt>${text(label)}</dt><dd>${esc(value ?? tr("Unknown"))}</dd></div>`;
export const bytes = (value = 0) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
export const statusTone = (status) => status === "proven" ? "ok" : ["failed", "unrecoverable"].includes(status) ? "bad" : ["needs_attention", "awaiting_approval", "paused"].includes(status) ? "warn" : "";

export function localGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
export function localSet(key, value) { try { localStorage.setItem(key, value); } catch { /* Presentation preferences remain usable without storage. */ } }

let timer;
export function notify(message, error = false) {
  const host = el("toast");
  if (!host) return;
  host.textContent = message;
  host.className = `toast ${error ? "bad" : ""}`; host.hidden = false;
  clearTimeout(timer); timer = setTimeout(() => { host.hidden = true; }, 5500);
}

export function translateStatic(root = document) {
  for (const value of root.querySelectorAll("[data-i18n]")) value.textContent = tr(value.dataset.i18n);
  for (const value of root.querySelectorAll("[data-i18n-placeholder]")) value.setAttribute("placeholder", tr(value.dataset.i18nPlaceholder));
  for (const value of root.querySelectorAll("[data-i18n-title]")) value.setAttribute("title", tr(value.dataset.i18nTitle));
  for (const value of root.querySelectorAll("[data-i18n-aria]")) value.setAttribute("aria-label", tr(value.dataset.i18nAria));
}

const paths = {
  navigation: "M4 5h16M4 12h16M4 19h16", settings: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M16 16l4 4",
  proof: "M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7zM8 12l3 3 5-6",
  extensions: "M8 3h8v5h5v8h-5v5H8v-5H3V8h5z",
  cognition: "M5 5h14v14H5zM8 8h8M8 12h6M8 16h4",
  lab: "M9 3h6M10 3v7L4 20h16l-6-10V3M7 15h10",
  collaboration: "M8 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M2 20v-3a5 5 0 0 1 10 0v3M14 20h8v-2a5 5 0 0 0-7-4",
  readiness: "M5 3h14v18H5zM8 8l2 2 5-5M8 14h8M8 18h5",
  folder: "M3 6h7l2 3h9v11H3z",
};
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name]); path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.6");
  svg.append(path); return svg;
}
