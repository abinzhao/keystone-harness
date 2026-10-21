import { button, node, tr, note } from "./dom.js";

export function parseDiff(source) {
  const rows = [];
  let path = "";
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of source.split("\n")) {
    if (text.startsWith("diff --git ")) inHunk = false;
    if (!inHunk && text.startsWith("+++ b/")) path = text.slice(6);
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; }
    if (inHunk && !hunk && text.startsWith("+")) rows.push({ kind: "addition", text: text.slice(1), path, oldLine: null, newLine: newLine++ });
    else if (inHunk && !hunk && text.startsWith("-")) rows.push({ kind: "deletion", text: text.slice(1), path, oldLine: oldLine++, newLine: null });
    else if (inHunk && text.startsWith(" ")) rows.push({ kind: "context", text: text.slice(1), path, oldLine: oldLine++, newLine: newLine++ });
    else if (text) rows.push({ kind: "meta", text, path, oldLine: null, newLine: null });
  }
  return rows;
}

export function splitDiff(rows) {
  const result = [];
  for (let index = 0; index < rows.length;) {
    if (["deletion", "addition"].includes(rows[index].kind)) {
      const left = [];
      const right = [];
      while (index < rows.length && ["deletion", "addition"].includes(rows[index].kind)) {
        const row = rows[index++];
        (row.kind === "deletion" ? left : right).push(row);
      }
      for (let at = 0; at < Math.max(left.length, right.length); at += 1) result.push({ left: left[at] ?? null, right: right[at] ?? null });
    } else {
      const row = rows[index++];
      result.push({ left: row, right: row });
    }
  }
  return result;
}

export function renderDiff(host, data, onReference) {
  host.replaceChildren();
  const controls = node("div", { class: "row" });
  const viewport = node("div", { class: "diff-scroll" });
  const mode = node("select", { "aria-label": tr("Diff layout") }, [
    node("option", { value: "unified", text: tr("Unified Diff") }),
    node("option", { value: "split", text: tr("Split Diff") }),
  ]);
  const search = node("input", { type: "search", "aria-label": tr("Search Diff"), placeholder: tr("Search Diff") });
  controls.append(mode, search);
  host.append(node("h2", { text: tr("Change produced by this task") }));
  host.append(note(data.scope === "worktree" ? "Current worktree changes, including edits not attributed to this task." : "Task-attributed paths; server-recomputed Diff, not independent evidence."));
  if (data.reason) host.append(node("p", { class: "muted", text: data.reason }));
  if (data.truncated) host.append(note("Diff is truncated.", "warn"));
  host.append(controls, viewport);
  const rows = parseDiff(data.unifiedDiff ?? "");
  const cell = (row, side) => {
    const td = node("td", { class: row?.kind ?? "" });
    if (!row) return td;
    const line = side === "left" ? row.oldLine : row.newLine;
    if (line != null) {
      const link = button(String(line), () => onReference(row.path, line));
      link.setAttribute("aria-label", tr("Reference {path} line {line}", { path: row.path, line }));
      td.append(link, document.createTextNode("  "));
    }
    td.append(document.createTextNode(row.text));
    return td;
  };
  const paint = () => {
    const table = node("table", { class: `diff-table ${mode.value}`, "aria-label": tr("Changes") });
    const body = node("tbody");
    const query = search.value.toLocaleLowerCase();
    if (mode.value === "split") {
      for (const row of splitDiff(rows)) {
        if (query && !`${row.left?.text ?? ""} ${row.right?.text ?? ""}`.toLocaleLowerCase().includes(query)) continue;
        body.append(node("tr", {}, [cell(row.left, "left"), cell(row.right, "right")]));
      }
    } else {
      for (const row of rows) {
        if (query && !row.text.toLocaleLowerCase().includes(query)) continue;
        body.append(node("tr", {}, [cell(row, row.newLine == null ? "left" : "right")]));
      }
    }
    table.append(body); viewport.replaceChildren(table);
    if (!rows.length) viewport.append(note(data.available ? "The repository reports no change for these paths." : "No diff is available."));
  };
  mode.onchange = paint; search.oninput = paint; paint();
}
