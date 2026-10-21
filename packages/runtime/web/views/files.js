import { node, button, tr, note, jsonDetails } from "../components/dom.js";
import { fileReference } from "../state/composer.js";
import { projectPath } from "../client/api.js";

export function createFilesView(host, { files, request, dialogs, reference }) {
  let disposed = false;
  let editorKey = "";
  let editorTab = null;
  let conflictKey = "";
  const search = node("input", { type: "search", placeholder: tr("Search project files"), "aria-label": tr("Search project files") });
  const results = node("div");
  const tree = node("div", { class: "file-tree" });
  const tabs = node("div", { class: "file-tabs", role: "tablist", "aria-label": tr("Open files") });
  const editor = node("textarea", { class: "code-editor", spellcheck: "false", "aria-label": tr("File contents") });
  const info = node("p", { class: "muted" });
  const status = node("div", { role: "status", "aria-live": "polite" });
  const conflict = node("div");
  const line = node("input", { type: "number", min: "1", value: "1", "aria-label": tr("Line number") });
  const addRef = button("@ File", () => {
    const tab = files.current();
    if (tab) reference(fileReference(tab.path, Number(line.value)));
  });
  const jump = () => {
    const lines = editor.value.split("\n");
    const selected = Math.min(Math.max(1, Number(line.value) || 1), lines.length);
    line.value = String(selected);
    const offset = lines.slice(0, selected - 1).reduce((sum, value) => sum + value.length + 1, 0);
    editor.focus(); editor.setSelectionRange(offset, offset + lines[selected - 1].length);
    editor.scrollTop = (selected - 1) * 19;
  };
  const save = button("Save file", async () => { save.disabled = true; await files.save(); render(); }, "primary");
  const reload = button("Reload from disk", async () => {
    const tab = files.current();
    if (!tab) return;
    if (tab.dirty && !(await dialogs.confirm("Discard unsaved file edits", note("Reload replaces this editor draft with the current file. Your repository is not modified."), "Reload from disk", true))) return;
    await files.open(tab.path, Number(line.value), true);
  });
  const undo = button("Undo file operation", async () => {
    const snapshot = files.current();
    const projectId = files.state.projectId;
    if (snapshot?.dirty && !(await dialogs.confirm("Undo file operation", note("Keep unsaved edits or discard them before reloading the compensated file."), "Discard draft and undo", true))) return;
    if (projectId !== files.state.projectId) return;
    const result = await files.undo();
    if (result && result.hash !== null && result.path && projectId === files.state.projectId) await files.open(result.path, snapshot?.line ?? 1, true);
  });
  const close = button("Close file", async () => {
    const tab = files.current();
    if (!tab) return;
    if (tab.dirty && !(await dialogs.confirm("Discard unsaved file edits", note("Closing this tab discards its editor draft."), "Close file", true))) return;
    files.close(tab.path);
  });
  const rename = button("Rename", async () => {
    const tab = files.current(); const projectId = files.state.projectId;
    if (!tab) return;
    if (tab.dirty) { status.replaceChildren(note("Save or discard the editor draft before renaming.", "warn")); return; }
    const destination = await dialogs.prompt("Rename file", "Destination path", tab.path);
    if (!destination || files.state.projectId !== projectId) return;
    const result = await files.mutate({ operation: "rename", path: tab.path, destination, expectedHash: tab.hash });
    if (result && files.state.projectId === projectId) { await files.open(destination); await files.list(files.state.directory); }
  });
  const remove = button("Delete", async () => {
    const tab = files.current(); const projectId = files.state.projectId;
    if (!tab) return;
    if (!(await dialogs.confirm("Delete file", node("div", {}, [note("This human-origin edit invalidates affected evidence. A compensating file operation is retained for Undo."), node("code", { text: tab.path })]), "Delete", true))) return;
    if (files.state.projectId !== projectId) return;
    const result = await files.mutate({ operation: "delete", path: tab.path, expectedHash: tab.hash });
    if (result) await files.list(files.state.directory);
  }, "danger");
  const create = button("Create file", async () => {
    const projectId = files.state.projectId;
    const path = await dialogs.prompt("Create file", "Relative file path", files.state.directory ? `${files.state.directory}/` : "");
    if (!path || projectId !== files.state.projectId) return;
    const result = await files.mutate({ operation: "create", path, content: "" });
    if (result && projectId === files.state.projectId) { await files.open(path); await files.list(files.state.directory); }
  });
  host.replaceChildren(node("div", { class: "stack" }, [
    node("div", { class: "row" }, [search, button("Search", async () => { await files.search(search.value); renderResults(); }), create, undo]),
    results, status,
    node("div", { class: "file-layout" }, [tree, node("div", { class: "file-workspace" }, [
      tabs, info, node("div", { class: "row editor-tools" }, [save, reload, rename, remove, close, line, button("Go to line", jump), addRef]), conflict, editor,
    ])]),
  ]));
  search.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); void files.search(search.value).then(renderResults); } };
  editor.oninput = () => { files.edit(editor.value); save.disabled = !files.current()?.dirty || !!files.current()?.conflict; info.textContent = `${files.current()?.path ?? ""} · ${tr("Unsaved draft")}`; };
  const renderResults = () => {
    results.replaceChildren();
    if (files.state.truncated) results.append(note("Search results are truncated.", "warn"));
    for (const result of files.state.results) results.append(button(`${result.path}:${result.line}  ${result.text}`, () => files.open(result.path, result.line), "nav-item"));
    if (search.value && !files.state.results.length) results.append(note("No matching files."));
  };
  const render = () => {
    if (disposed) return;
    const state = files.state;
    status.replaceChildren();
    if (state.loading) status.append(note("Loading files"));
    if (state.error) status.append(note(state.error, "bad"));
    undo.disabled = !state.undo; create.disabled = !state.projectId;
    tree.replaceChildren(node("p", { class: "muted", text: state.directory || tr("Project root") }));
    if (state.directory) tree.append(button("Parent directory", () => files.list(state.directory.split("/").slice(0, -1).join("/"))));
    for (const entry of state.entries) {
      tree.append(button(`${entry.kind === "directory" ? "+ " : ""}${entry.name} ${entry.gitStatus ? `[${entry.gitStatus}]` : ""}`, () => entry.kind === "directory" ? files.list(entry.path) : files.open(entry.path)));
    }
    if (state.nextOffset != null) tree.append(button("Load more", () => files.list(state.directory, state.nextOffset)));
    tabs.replaceChildren();
    for (const tab of state.tabs) {
      const choice = button(`${tab.path}${tab.dirty ? " *" : ""}`, () => files.open(tab.path), tab.path === state.active ? "active" : "");
      choice.setAttribute("role", "tab"); choice.setAttribute("aria-selected", String(tab.path === state.active));
      tabs.append(choice);
    }
    const tab = files.current();
    for (const control of [save, reload, rename, remove, close, line, addRef]) control.disabled = !tab;
    editor.hidden = !tab;
    if (!tab) { info.textContent = tr("Select a file to read or edit."); conflict.replaceChildren(); editorKey = ""; editorTab = null; return; }
    info.textContent = `${tab.path} · ${bytesLabel(tab.size)} · ${tr(tab.dirty ? "Unsaved draft" : "Current workspace")} · ${tab.hash ?? ""}`;
    save.disabled = !tab.dirty || !!tab.conflict || tab.binary || tab.truncated;
    editor.readOnly = tab.binary || tab.truncated;
    const key = `${state.projectId}:${tab.path}:${tab.hash}`;
    if (key !== editorKey || tab !== editorTab) {
      editor.value = tab.binary ? tr("Binary files cannot be edited here.") : tab.draft;
      line.value = String(tab.line ?? 1); editorKey = key; editorTab = tab;
    }
    if (tab.truncated) status.append(note("File preview is truncated; editing is disabled.", "warn"));
    if (tab.binary) status.append(note("Binary files cannot be edited here.", "warn"));
    const nextConflict = `${key}:${!!tab.conflict}`;
    if (nextConflict !== conflictKey) {
      conflictKey = nextConflict; conflict.replaceChildren();
      if (tab.conflict) {
        const capturedProject = state.projectId;
        conflict.append(note("File changed on disk. Your draft is preserved; reload and reconcile before saving.", "warn"));
        conflict.append(jsonDetails("Conflict details", tab.conflict));
        const compare = node("div", { class: "conflict-grid" }, [
          node("div", {}, [node("h4", { text: tr("Your draft") }), node("pre", { text: tab.draft })]),
          node("div", {}, [node("h4", { text: tr("Current file") }), node("pre", { text: tr("Loading files") })]),
        ]);
        conflict.append(compare);
        void request(`${projectPath(state.projectId)}/file?${new URLSearchParams({ path: tab.path })}`).then((latest) => {
          if (!disposed && capturedProject === files.state.projectId && key === editorKey && compare.isConnected) compare.lastChild.querySelector("pre").textContent = latest.binary ? tr("Binary files cannot be edited here.") : latest.content;
        }).catch((error) => { if (compare.isConnected) compare.lastChild.querySelector("pre").textContent = error.message; });
      }
    }
  };
  const unsubscribe = files.subscribe(render);
  render();
  if (files.state.projectId && !files.state.entries.length) void files.list();
  return { dispose() { disposed = true; unsubscribe(); } };
}

function bytesLabel(value) { return value == null ? "" : `${value} B`; }
