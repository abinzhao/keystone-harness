const KEY = "keystone.file-drafts.v1";
export const FILE_DRAFT_LIMITS = Object.freeze({
  maxDraftBytes: 512 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxEntries: 20, maxAgeMs: 7 * 24 * 60 * 60 * 1000,
});
const bytes = (value) => new TextEncoder().encode(value).byteLength;
const same = (record, projectId, path) => record.projectId === projectId && record.path === path;

/** Presentation data only: no automatic file writes or evidence admission. */
export function createFileDraftStore(storage, { limits = {}, now = Date.now } = {}) {
  const ceiling = { ...FILE_DRAFT_LIMITS, ...limits };
  const valid = (record) => record && typeof record.projectId === "string" && typeof record.path === "string"
    && typeof record.hash === "string" && typeof record.draft === "string" && Number.isFinite(record.at)
    && record.at <= now() && bytes(record.draft) <= ceiling.maxDraftBytes;
  function read() {
    if (!storage) return { records: [], issue: "storage_unavailable" };
    let raw;
    try { raw = storage.getItem(KEY); } catch { return { records: [], issue: "storage_unavailable" }; }
    try {
      if (!raw) return { records: [], issue: null };
      if (bytes(raw) > ceiling.maxTotalBytes) return { records: [], issue: "capacity" };
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > ceiling.maxEntries
        || !data.records.every(valid)) return { records: [], issue: "invalid" };
      return { records: data.records, issue: null };
    } catch { return { records: [], issue: "invalid" }; }
  }
  function write(records) {
    if (!storage) return "storage_unavailable";
    try {
      if (!records.length && storage.removeItem) storage.removeItem(KEY);
      else storage.setItem(KEY, JSON.stringify({ version: 1, records }));
      return null;
    } catch { return "storage_unavailable"; }
  }
  return {
    list(projectId) {
      return read().records.filter((record) => record.projectId === projectId && now() - record.at <= ceiling.maxAgeMs);
    },
    get(projectId, path) {
      const { records, issue } = read();
      const record = records.find((entry) => same(entry, projectId, path));
      if (!record) return { record: null, issue };
      if (now() - record.at > ceiling.maxAgeMs) {
        write(records.filter((entry) => entry !== record));
        return { record: null, issue: "expired" };
      }
      return { record, issue: null };
    },
    set(projectId, tab) {
      const { records, issue } = read();
      if (issue) return issue;
      const retained = records.filter((record) => !same(record, projectId, tab.path) && now() - record.at <= ceiling.maxAgeMs);
      const record = { projectId, path: tab.path, hash: tab.hash, draft: tab.draft, at: now() };
      if (!valid(record)) {
        const failure = write(retained);
        return failure ?? (bytes(tab.draft) > ceiling.maxDraftBytes ? "too_large" : "invalid");
      }
      const next = [...retained, record];
      if (next.length > ceiling.maxEntries || bytes(JSON.stringify({ version: 1, records: next })) > ceiling.maxTotalBytes) {
        const failure = write(retained);
        return failure ?? "capacity";
      }
      return write(next);
    },
    remove(projectId, path) {
      const { records, issue } = read();
      if (issue) return issue;
      return write(records.filter((entry) => !same(entry, projectId, path)));
    },
  };
}
