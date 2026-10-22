import assert from "node:assert/strict";
import test from "node:test";
const { groupProjectTasks } = await import(new URL("../web/state/navigation.js", import.meta.url).href);

test("project navigation groups attention, running and finished tasks by recorded update time", () => {
  const task = (taskId: string, status: string, updatedAt: string, projectId = "p") =>
    ({ taskId, status, updatedAt, projectId, title: taskId });
  const tasks = [
    task("old-finished", "proven", "2026-10-20T00:00:00Z"),
    task("running", "executing", "2026-10-22T00:00:00Z"),
    task("new-finished", "exited_gracefully", "2026-10-22T01:00:00Z"),
    task("attention", "needs_attention", "2026-10-21T00:00:00Z"),
    task("paused", "paused", "2026-10-22T01:00:00Z"),
    task("other", "needs_attention", "2026-10-22T02:00:00Z", "q"),
  ];
  const groups = groupProjectTasks([{ projectId: "p" }], tasks)[0]!;
  assert.deepEqual(groups.sections.map((section: any) => [section.kind, section.tasks.map((row: any) => row.taskId)]), [
    ["attention", ["paused", "attention"]], ["running", ["running"]], ["finished", ["new-finished", "old-finished"]],
  ]);
  assert.deepEqual(tasks.map(row => row.taskId), ["old-finished", "running", "new-finished", "attention", "paused", "other"]);
});

test("search preserves status grouping and omits empty groups", () => {
  const group = groupProjectTasks([{ projectId: "p" }], [
    { taskId: "a", projectId: "p", title: "Check refresh", status: "executing" },
    { taskId: "b", projectId: "p", title: "Explain refresh", status: "proven" },
  ], "explain")[0]!;
  assert.deepEqual(group.sections.map((section: any) => section.kind), ["finished"]);
  assert.deepEqual(group.tasks.map((task: any) => task.taskId), ["b"]);
});
