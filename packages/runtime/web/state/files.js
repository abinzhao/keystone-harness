import { post, projectPath } from "../client/api.js";
import { createFileDraftStore } from "./file-drafts.js";

export function createFileClient({ request, storage = null, draftLimits, now, onMutation = () => {} }) {
  const drafts = createFileDraftStore(storage, { limits: draftLimits, now });
  const state = { projectId: null, tabs: [], active: null, entries: [], directory: "", nextOffset: null, results: [], truncated: false, loading: false, error: "", undo: null };
  const listeners = new Set();
  const projects = new Map();
  const requests = new Set();
  const reads = new Map();
  let version = 0;
  let readVersion = 0;
  let searchVersion = 0;
  let treeVersion = 0;
  const emit = () => listeners.forEach((listener) => listener(state));
  const controller = () => { const value = new AbortController(); requests.add(value); return value; };
  const current = () => state.tabs.find((tab) => tab.path === state.active);
  const persist = (projectId, tab) => {
    // A disk conflict must survive refresh without rebasing the recovery draft.
    tab.draftIssue = tab.dirty ? drafts.set(projectId, { ...tab, hash: tab.conflict?.expectedHash ?? tab.hash }) : drafts.remove(projectId, tab.path);
  };
  const client = {
    state,
    current,
    recoverableDrafts() { return drafts.list(state.projectId); },
    discardStoredDraft(path) {
      const tab = state.tabs.find((entry) => entry.path === path);
      if (tab?.saving || tab?.dirty) return;
      if (tab) { tab.recovery = null; tab.draftIssue = drafts.remove(state.projectId, path); }
      else drafts.remove(state.projectId, path);
      emit();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setProject(projectId) {
      if (state.projectId === projectId) return;
      if (state.projectId) projects.set(state.projectId, { tabs: state.tabs, active: state.active, undo: state.undo });
      version += 1;
      requests.forEach((value) => value.abort()); requests.clear();
      Object.assign(state, { projectId, tabs: [], active: null, entries: [], directory: "", nextOffset: null, results: [], truncated: false, loading: false, error: "", undo: null }, projects.get(projectId) ?? {});
      emit();
    },
    async list(path = "", offset = 0) {
      if (!state.projectId) return;
      const selected = version;
      const sequence = ++treeVersion;
      const abort = controller();
      state.loading = true; emit();
      try {
        const data = await request(`${projectPath(state.projectId)}/files?${new URLSearchParams({ path: path || ".", offset: String(offset), limit: "100" })}`, { signal: abort.signal });
        if (abort.signal.aborted || selected !== version || sequence !== treeVersion) return;
        state.entries = offset ? [...state.entries, ...data.entries] : data.entries;
        state.directory = path; state.nextOffset = data.nextOffset;
        state.error = "";
      } catch (error) { if (!abort.signal.aborted && selected === version && sequence === treeVersion) state.error = error.message; }
      finally { requests.delete(abort); if (selected === version && sequence === treeVersion) { state.loading = false; emit(); } }
    },
    async search(q) {
      if (!state.projectId) return;
      const selected = version;
      const sequence = ++searchVersion;
      const abort = controller();
      try {
        const data = await request(`${projectPath(state.projectId)}/search?${new URLSearchParams({ q })}`, { signal: abort.signal });
        if (abort.signal.aborted || selected !== version || sequence !== searchVersion) return;
        state.results = data.results; state.truncated = data.truncated; state.error = ""; emit();
      } catch (error) { if (!abort.signal.aborted && selected === version && sequence === searchVersion) { state.error = error.message; emit(); } }
      finally { requests.delete(abort); }
    },
    async open(path, line = 1, reload = false, savedContent = null) {
      if (!state.projectId) return;
      const existing = state.tabs.find((tab) => tab.path === path);
      if (existing && !reload) { state.active = path; existing.line = line; emit(); return; }
      const selected = version;
      const editGeneration = existing?.editGeneration ?? 0;
      const expectedHash = existing?.conflict?.expectedHash ?? existing?.hash;
      const sequence = ++readVersion;
      reads.set(path, sequence);
      const abort = controller();
      state.loading = true; emit();
      try {
        const data = await request(`${projectPath(state.projectId)}/file?${new URLSearchParams({ path })}`, { signal: abort.signal });
        if (abort.signal.aborted || selected !== version || reads.get(path) !== sequence) return;
        const preserveDraft = existing && (existing.editGeneration !== editGeneration
          || (savedContent != null && (existing.draft !== savedContent || data.hash !== expectedHash)));
        const draft = preserveDraft ? existing.draft : data.content ?? "";
        const conflict = preserveDraft && data.hash !== expectedHash ? { expectedHash, actualHash: data.hash } : null;
        const stored = !existing ? drafts.get(state.projectId, path) : { record: null, issue: null };
        const recovery = stored.record && stored.record.draft !== data.content
          ? { ...stored.record, conflict: stored.record.hash !== data.hash } : null;
        const tab = { ...data, draft, recovery, draftIssue: stored.issue, saving: existing?.saving ?? false, conflict, editGeneration: existing?.editGeneration ?? 0, line, dirty: draft !== (data.content ?? "") };
        const index = state.tabs.findIndex((item) => item.path === path);
        if (index === -1) state.tabs.push(tab); else state.tabs[index] = tab;
        if (existing) persist(state.projectId, tab);
        if (sequence === readVersion) state.active = path;
        state.error = "";
      } catch (error) { if (!abort.signal.aborted && selected === version) state.error = error.message; }
      finally { requests.delete(abort); if (selected === version) { state.loading = false; emit(); } }
    },
    edit(content) {
      const tab = current();
      if (tab && !tab.binary && !tab.truncated && !tab.recovery) {
        tab.editGeneration += 1;
        tab.draft = content; tab.dirty = content !== tab.content;
        persist(state.projectId, tab);
      }
    },
    recoverDraft({ acceptDiskChange = false } = {}) {
      const tab = current();
      if (!tab?.recovery || tab.binary || tab.truncated || (tab.recovery.conflict && !acceptDiskChange)) return false;
      tab.editGeneration += 1;
      tab.draft = tab.recovery.draft; tab.recovery = null; tab.dirty = tab.draft !== tab.content;
      persist(state.projectId, tab); emit(); return true;
    },
    discardDraft() {
      const tab = current();
      if (!tab || tab.saving) return;
      tab.editGeneration += 1;
      tab.recovery = null; tab.conflict = null; tab.draft = tab.content ?? ""; tab.dirty = false;
      tab.draftIssue = drafts.remove(state.projectId, tab.path); emit();
    },
    hasUnsavedDrafts() {
      return [...projects.values(), state].some((project) => project.tabs.some((tab) => tab.dirty || tab.recovery || tab.saving));
    },
    close(path) {
      const tab = state.tabs.find((entry) => entry.path === path);
      if (tab?.saving) return;
      if (tab) drafts.remove(state.projectId, path);
      state.tabs = state.tabs.filter((tab) => tab.path !== path);
      if (state.active === path) state.active = state.tabs.at(-1)?.path ?? null;
      emit();
    },
    async mutate(body) {
      if (!state.projectId) return null;
      const projectId = state.projectId;
      const selected = version;
      try {
        const result = await request(`${projectPath(projectId)}/files`, post(body));
        onMutation(projectId, result);
        if (selected !== version) return result;
        state.undo = result.mutationId ? { mutationId: result.mutationId, path: body.path, destination: body.destination, expectedHash: result.hash ?? null } : null;
        state.error = "";
        if (body.operation === "delete" || body.operation === "rename") client.close(body.path);
        emit();
        return result;
      } catch (error) {
        if (selected !== version) return null;
        state.error = error.message;
        const tab = state.tabs.find((item) => item.path === body.path);
        if (tab && error.status === 409) tab.conflict = { ...error.body, message: error.message };
        emit();
        return null;
      }
    },
    async save() {
      const tab = current();
      if (!tab || tab.binary || tab.truncated || tab.conflict || tab.recovery || tab.saving || !tab.dirty) return;
      const selected = version;
      const projectId = state.projectId;
      const content = tab.draft;
      tab.saving = true; emit();
      try {
        const result = await client.mutate({ operation: "write", path: tab.path, content, expectedHash: tab.hash });
        if (!result) return;
        if (typeof result.hash === "string") {
          tab.content = content; tab.hash = result.hash; tab.dirty = tab.draft !== content;
          persist(projectId, tab);
        }
        if (selected !== version) {
          // The tab still belongs to its cached project, not the selected project's editor.
          return;
        }
        await client.open(tab.path, tab.line, true, content);
      } finally {
        tab.saving = false;
        if (selected === version) {
          const active = state.tabs.find((entry) => entry.path === tab.path);
          if (active) active.saving = false;
          emit();
        }
      }
    },
    async undo() {
      if (!state.undo) return;
      const { mutationId, path, expectedHash, destination } = state.undo;
      const selected = version;
      const result = await client.mutate({ operation: "undo", mutationId, path, expectedHash });
      if (result && selected === version) {
        if (destination) client.close(destination);
        if (result.hash === null) client.close(path);
        state.undo = null; await client.list(state.directory);
      }
      return result;
    },
    dispose() { requests.forEach((value) => value.abort()); listeners.clear(); },
  };
  return client;
}
