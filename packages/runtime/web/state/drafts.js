const empty = () => ({ request: "", writePaths: "", allowedCommands: "", access: "read", attachmentIds: [], references: [], reason: "", goal: "", modelId: "" });

export function createDraftStore(storage) {
  const memory = new Map();
  const keyFor = (projectId, taskId) => `keystone.draft.${encodeURIComponent(projectId ?? "none")}.${encodeURIComponent(taskId ?? "new")}`;
  return {
    get(projectId, taskId) {
      const key = keyFor(projectId, taskId);
      try { return { ...empty(), ...JSON.parse(memory.get(key) ?? storage?.getItem(key) ?? "{}") }; }
      catch { return empty(); }
    },
    set(projectId, taskId, patch) {
      const key = keyFor(projectId, taskId);
      const value = { ...this.get(projectId, taskId), ...patch };
      const serialized = JSON.stringify(value);
      memory.set(key, serialized);
      try { storage?.setItem(key, serialized); } catch { /* The in-memory draft survives unavailable storage. */ }
      return value;
    },
    clear(projectId, taskId) { return this.set(projectId, taskId, empty()); },
  };
}
