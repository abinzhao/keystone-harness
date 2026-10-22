import assert from "node:assert/strict";
import test from "node:test";

const moduleAt = (path: string): Promise<any> => import(new URL(`../web/${path}`, import.meta.url).href);
const settle = () => new Promise((resolve) => setImmediate(resolve));
test("refresh lists isolated recoverable drafts even when their files cannot be opened", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture(); const disk = diskFixture();
  const first = createFileClient({ request: disk.request, storage });
  first.setProject("A"); await first.open("src/a.ts"); first.edit("offline recovery");
  const next = createFileClient({ request: async () => { throw new Error("missing file"); }, storage });
  next.setProject("B"); assert.deepEqual(next.recoverableDrafts(), []);
  next.setProject("A"); await next.open("src/a.ts");
  assert.equal(next.recoverableDrafts()[0].draft, "offline recovery");
  next.discardStoredDraft("src/a.ts");
  assert.deepEqual(next.recoverableDrafts(), []);
});

test("successful write preserves the returned disk hash when follow-up read fails", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture(); let reads = 0;
  const request = async (_path: string, init: any = {}) => {
    if (init.method === "POST") return { hash: "written-hash" };
    if (++reads > 1) throw new Error("read disconnected");
    return { path: "a.ts", content: "old", hash: "old-hash" };
  };
  const client = createFileClient({ request, storage });
  client.setProject("A"); await client.open("a.ts"); client.edit("saved"); await client.save();
  assert.equal(client.current().hash, "written-hash");
  assert.equal(client.current().dirty, false);
  assert.equal(client.state.error, "read disconnected");
});

test("storage access errors are distinguished from invalid stored data", async () => {
  const { createFileDraftStore } = await moduleAt("state/file-drafts.js");
  assert.equal(createFileDraftStore({ getItem() { throw new Error("denied"); } }).get("A", "a").issue, "storage_unavailable");
});

function storageFixture() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}
function diskFixture() {
  let disk = { path: "src/a.ts", content: "disk-original", hash: "original-hash", size: 13, binary: false, truncated: false };
  const writes: any[] = [];
  return {
    set(content: string, hash: string) { disk = { ...disk, content, hash }; },
    writes,
    request: async (_path: string, init: any = {}) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        writes.push(body);
        assert.equal(body.expectedHash, disk.hash);
        disk = { ...disk, content: body.content, hash: "saved-hash" };
        return { mutationId: "mutation", hash: disk.hash };
      }
      return { ...disk };
    },
  };
}

test("refresh offers a persisted draft without changing disk contents or writing", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture(); const disk = diskFixture();
  const first = createFileClient({ request: disk.request, storage });
  first.setProject("project-A"); await first.open("src/a.ts"); first.edit("unsaved"); first.dispose();
  const reopened = createFileClient({ request: disk.request, storage });
  reopened.setProject("project-A"); await reopened.open("src/a.ts");
  assert.equal(reopened.current().recovery?.draft, "unsaved");
  assert.equal(reopened.current().recovery?.hash, "original-hash");
  assert.equal(reopened.current().content, "disk-original");
  assert.equal(reopened.current().draft, "disk-original");
  assert.equal(reopened.current().dirty, false);
  assert.equal(disk.writes.length, 0);
  assert.equal(reopened.recoverDraft(), true);
  assert.equal(reopened.current().draft, "unsaved");
  assert.equal(reopened.current().hash, "original-hash");
  await reopened.save();
  assert.equal(disk.writes.length, 1);
  const saved = createFileClient({ request: disk.request, storage });
  saved.setProject("project-A"); await saved.open("src/a.ts");
  assert.equal(saved.current().recovery, null);
});

test("changed disk hash cannot be silently rebased when recovering", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture(); const disk = diskFixture();
  const first = createFileClient({ request: disk.request, storage });
  first.setProject("A"); await first.open("src/a.ts"); first.edit("unsaved");
  disk.set("external edit", "external-hash");
  const next = createFileClient({ request: disk.request, storage });
  next.setProject("A"); await next.open("src/a.ts");
  assert.equal(next.current().recovery?.conflict, true);
  assert.equal(next.recoverDraft(), false);
  await next.save(); assert.equal(disk.writes.length, 0);
  assert.equal(next.current().draft, "external edit");
  assert.equal(next.recoverDraft({ acceptDiskChange: true }), true);
  assert.equal(next.current().hash, "external-hash");
  await next.save();
  assert.equal(disk.writes[0].expectedHash, "external-hash");
});

test("explicit discard removes recovery without writing a file", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture(); const disk = diskFixture();
  const first = createFileClient({ request: disk.request, storage });
  first.setProject("A"); await first.open("src/a.ts"); first.edit("discard me");
  const next = createFileClient({ request: disk.request, storage });
  next.setProject("A"); await next.open("src/a.ts");
  next.discardDraft();
  assert.equal(next.current().recovery, null);
  assert.equal(next.current().draft, "disk-original");
  const last = createFileClient({ request: disk.request, storage });
  last.setProject("A"); await last.open("src/a.ts");
  assert.equal(last.current().recovery, null);
  assert.equal(disk.writes.length, 0);
});

test("same paths in different projects retain isolated recovery records", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture(); const disk = diskFixture();
  const first = createFileClient({ request: disk.request, storage });
  first.setProject("A"); await first.open("src/a.ts"); first.edit("A only");
  first.setProject("B"); await first.open("src/a.ts"); first.edit("B only");
  const next = createFileClient({ request: disk.request, storage });
  next.setProject("A"); await next.open("src/a.ts");
  assert.equal(next.current().recovery?.draft, "A only");
  next.setProject("B"); await next.open("src/a.ts");
  assert.equal(next.current().recovery?.draft, "B only");
  next.setProject("C"); await next.open("src/a.ts"); assert.equal(next.current().recovery, null);
  next.setProject("A"); assert.equal(next.current().recovery?.draft, "A only");
});

test("unavailable and quota-limited storage preserve memory edits and report loss risk", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  for (const storage of [null, {
    getItem() { return null; },
    setItem() { throw new Error("quota"); },
    removeItem() { throw new Error("quota"); },
  }]) {
    const client = createFileClient({ request: diskFixture().request, storage });
    client.setProject("A"); await client.open("src/a.ts"); client.edit("must survive in memory");
    assert.equal(client.current().draft, "must survive in memory");
    assert.equal(client.current().draftIssue, "storage_unavailable");
    assert.equal(client.hasUnsavedDrafts(), true);
    client.setProject("B"); client.setProject("A");
    assert.equal(client.current().draft, "must survive in memory");
    assert.equal(client.hasUnsavedDrafts(), true);
  }
});

test("UTF-8 draft size ceiling rejects persistence and clears an older stale record", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture(); const disk = diskFixture();
  const client = createFileClient({ request: disk.request, storage, draftLimits: { maxDraftBytes: 16 } });
  client.setProject("A"); await client.open("src/a.ts"); client.edit("small");
  client.edit("\u4e2d".repeat(6));
  assert.equal(client.current().draftIssue, "too_large");
  assert.equal(client.current().draft.length, 6);
  const reopened = createFileClient({ request: disk.request, storage, draftLimits: { maxDraftBytes: 16 } });
  reopened.setProject("A"); await reopened.open("src/a.ts"); assert.equal(reopened.current().recovery, null);
});

test("expired drafts are not offered and future timestamp records are refused", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  for (const later of [2000, 900]) {
    const storage = storageFixture(); const disk = diskFixture();
    const first = createFileClient({ request: disk.request, storage, now: () => 1000, draftLimits: { maxAgeMs: 100 } });
    first.setProject("A"); await first.open("src/a.ts"); first.edit("old");
    const next = createFileClient({ request: disk.request, storage, now: () => later, draftLimits: { maxAgeMs: 100 } });
    next.setProject("A"); await next.open("src/a.ts");
    assert.equal(next.current().recovery, null);
    assert.equal(next.current().draftIssue, later === 2000 ? "expired" : "invalid");
  }
});

test("aggregate capacity never evicts another project's recoverable draft", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture(); const disk = diskFixture();
  const client = createFileClient({ request: disk.request, storage, draftLimits: { maxEntries: 1 } });
  client.setProject("A"); await client.open("src/a.ts"); client.edit("A");
  client.setProject("B"); await client.open("src/a.ts"); client.edit("B");
  assert.equal(client.current().draftIssue, "capacity");
  const next = createFileClient({ request: disk.request, storage });
  next.setProject("A"); await next.open("src/a.ts"); assert.equal(next.current().recovery?.draft, "A");
});

test("late successful save keeps typing and persists the new disk baseline", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture();
  let finish!: (value: any) => void;
  const reload = new Promise((resolve) => { finish = resolve; });
  let reads = 0; let writes = 0;
  const request = async (_path: string, init: any = {}) => {
    if (init.method === "POST") { writes += 1; return { mutationId: "m", hash: "saved-hash" }; }
    return ++reads === 1 ? { path: "src/a.ts", content: "old", hash: "old-hash" } : reload;
  };
  const client = createFileClient({ request, storage });
  client.setProject("A"); await client.open("src/a.ts"); client.edit("saved");
  const saving = client.save(); await settle(); client.edit("still typing");
  const duplicate = client.save(); await settle();
  finish({ path: "src/a.ts", content: "saved", hash: "saved-hash" });
  await Promise.all([saving, duplicate]);
  assert.equal(writes, 1, "duplicate save is blocked while pending");
  assert.equal(client.current().draft, "still typing");
  assert.equal(client.current().hash, "saved-hash");
  const next = createFileClient({ request: async () => ({ path: "src/a.ts", content: "saved", hash: "saved-hash" }), storage });
  next.setProject("A"); await next.open("src/a.ts");
  assert.equal(next.current().recovery?.draft, "still typing");
  assert.equal(next.current().recovery?.conflict, false);
});

test("save reread preserves typing and its accepted hash when an external writer intervenes", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  for (const continueTyping of [true, false]) {
    const storage = storageFixture(); const disk = diskFixture();
    let finish!: (value: any) => void;
    const reread = new Promise((resolve) => { finish = resolve; });
    let reads = 0;
    const request = async (path: string, init: any = {}) => {
      if (init.method !== "POST" && ++reads === 2) return reread;
      return disk.request(path, init);
    };
    const client = createFileClient({ request, storage });
    client.setProject("A"); await client.open("src/a.ts"); client.edit("saved");
    const saving = client.save(); await settle();
    if (continueTyping) client.edit("newest typing");
    disk.set("external version", "external-hash");
    finish(await disk.request("src/a.ts")); await saving;
    assert.equal(client.current().draft, continueTyping ? "newest typing" : "saved");
    assert.equal(client.current().content, "external version");
    assert.equal(client.current().hash, "external-hash");
    assert.equal(client.current().conflict?.expectedHash, "saved-hash");
    assert.equal(client.current().conflict?.actualHash, "external-hash");
    assert.equal(client.recoverableDrafts()[0].hash, "saved-hash");
    client.edit("typing after conflict");
    assert.equal(client.recoverableDrafts()[0].hash, "saved-hash");
    await client.save(); assert.equal(disk.writes.length, 1, "conflict blocks overwriting the external version");
    const next = createFileClient({ request: disk.request, storage });
    next.setProject("A"); await next.open("src/a.ts");
    assert.equal(next.current().recovery?.draft, "typing after conflict");
    assert.equal(next.current().recovery?.conflict, true);
    assert.equal(next.recoverDraft(), false);
    assert.equal(next.recoverDraft({ acceptDiskChange: true }), true);
    await next.save();
    assert.equal(disk.writes[1].expectedHash, "external-hash");
  }
});

test("confirmed reload preserves edits made while its disk read is pending", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  for (const externalChange of [false, true]) {
    const storage = storageFixture(); const disk = diskFixture();
    let finish!: (value: any) => void;
    const reread = new Promise((resolve) => { finish = resolve; });
    let reads = 0;
    const request = async (path: string, init: any = {}) => ++reads === 2 ? reread : disk.request(path, init);
    const client = createFileClient({ request, storage });
    client.setProject("A"); await client.open("src/a.ts"); client.edit("confirmed discard");
    client.discardDraft();
    const reloading = client.open("src/a.ts", 1, true); await settle();
    client.edit("newest recovery");
    if (externalChange) disk.set("external version", "external-hash");
    finish(await disk.request("src/a.ts")); await reloading;
    assert.equal(client.current().draft, "newest recovery");
    assert.equal(client.current().content, externalChange ? "external version" : "disk-original");
    assert.equal(client.current().hash, externalChange ? "external-hash" : "original-hash");
    assert.equal(client.current().dirty, true);
    assert.equal(!!client.current().conflict, externalChange);
    assert.equal(client.recoverableDrafts()[0].draft, "newest recovery");
    assert.equal(client.recoverableDrafts()[0].hash, "original-hash");
    const next = createFileClient({ request: disk.request, storage });
    next.setProject("A"); await next.open("src/a.ts");
    assert.equal(next.current().recovery?.draft, "newest recovery");
    assert.equal(next.current().recovery?.conflict, externalChange);
    assert.equal(disk.writes.length, 0);
    if (externalChange) {
      await client.save(); assert.equal(disk.writes.length, 0);
      client.discardDraft(); await client.open("src/a.ts", 1, true);
      assert.equal(client.current().conflict, null);
      assert.equal(client.current().draft, "external version");
      assert.deepEqual(client.recoverableDrafts(), []);
    }
  }
});

test("reload admission detects editing even when typing returns to the original draft", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture(); const disk = diskFixture();
  let finish!: (value: any) => void;
  const reread = new Promise((resolve) => { finish = resolve; });
  let reads = 0;
  const client = createFileClient({ storage, request: async (path: string, init: any = {}) => ++reads === 2 ? reread : disk.request(path, init) });
  client.setProject("A"); await client.open("src/a.ts");
  const reloading = client.open("src/a.ts", 1, true); await settle();
  client.edit("temporary typing"); client.edit("disk-original");
  disk.set("external version", "external-hash");
  finish(await disk.request("src/a.ts")); await reloading;
  assert.equal(client.current().draft, "disk-original");
  assert.equal(client.current().content, "external version");
  assert.ok(client.current().conflict);
  assert.equal(client.recoverableDrafts()[0].draft, "disk-original");
});

test("reload without intervening edits accepts disk content and clears discarded recovery", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture(); const disk = diskFixture();
  const client = createFileClient({ request: disk.request, storage });
  client.setProject("A"); await client.open("src/a.ts"); client.edit("discarded");
  client.discardDraft(); disk.set("external version", "external-hash");
  await client.open("src/a.ts", 1, true);
  assert.equal(client.current().draft, "external version");
  assert.equal(client.current().dirty, false);
  assert.equal(client.current().conflict, null);
  assert.deepEqual(client.recoverableDrafts(), []);
  assert.equal(disk.writes.length, 0);
});

test("a save finishing after project switch updates only its own recovery record", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const storage = storageFixture();
  let finish!: (value: any) => void;
  const savingResponse = new Promise((resolve) => { finish = resolve; });
  const request = async (_path: string, init: any = {}) => init.method === "POST" ? savingResponse
    : { path: "src/a.ts", content: "old", hash: "old-hash" };
  const client = createFileClient({ request, storage });
  client.setProject("A"); await client.open("src/a.ts"); client.edit("saved");
  const saving = client.save(); client.edit("A typing");
  client.setProject("B"); await client.open("src/a.ts"); client.edit("B typing");
  finish({ mutationId: "m", hash: "saved-hash" }); await saving;
  assert.equal(client.current().draft, "B typing");
  client.setProject("A");
  assert.equal(client.current().draft, "A typing");
  assert.equal(client.current().hash, "saved-hash");
  const next = createFileClient({ storage, request: async () => ({ path: "src/a.ts", content: "saved", hash: "saved-hash" }) });
  next.setProject("A"); await next.open("src/a.ts");
  assert.equal(next.current().recovery?.hash, "saved-hash");
});

test("corrupt storage cannot be interpreted as a recovery draft", async () => {
  const { createFileClient } = await moduleAt("state/files.js");
  const client = createFileClient({ request: diskFixture().request, storage: { getItem: () => "{bad", setItem() {} } });
  client.setProject("A"); await client.open("src/a.ts");
  assert.equal(client.current().recovery, null);
  assert.equal(client.current().draftIssue, "invalid");
});
