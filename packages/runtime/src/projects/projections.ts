import { readFile, readdir } from "node:fs/promises";
import { KernelSession, type KeystonePaths } from "@keystone/kernel";
import { projectProfileSchema, type TaskId } from "@keystone/schemas";
import { taskIdValidator } from "../../../schemas/src/schemas/ids.ts";
import type { WorkbenchProject, WorkbenchProjectRecord } from "../../../schemas/src/schemas/workbench.ts";

type ScanProjection = Pick<WorkbenchProject, "scanStatus" | "support">;
async function scan(paths: KeystonePaths, record: WorkbenchProjectRecord): Promise<ScanProjection> {
  try {
    const profile = projectProfileSchema.parse(JSON.parse(await readFile(paths.projectFile(record.workspaceId), "utf8")));
    if (profile.projectId !== record.workspaceId || profile.rootPath !== record.rootPath) {
      throw new Error("profile belongs to another workspace");
    }
    return { scanStatus: "scanned", support: profile.support };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ?
      { scanStatus: "not_scanned", support: { status: "unknown", reasons: [] } } :
      { scanStatus: "unavailable", support: { status: "unknown", reasons: ["saved engineering profile is invalid or inaccessible"] } };
  }
}

async function tasks(
  paths: KeystonePaths, record: WorkbenchProjectRecord,
): Promise<{ tasks: readonly TaskId[]; reason?: string }> {
  const result: TaskId[] = [];
  let incomplete = false;
  try {
    const entries = await readdir(paths.tasksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!taskIdValidator.is(entry.name)) continue;
      if (!entry.isDirectory()) { incomplete = true; continue; }
      try {
        const taskId = taskIdValidator.parse(entry.name);
        const session = await KernelSession.open({ paths, taskId });
        if (session.projectId === record.projectId || session.projectId === record.workspaceId) result.push(taskId);
      } catch { incomplete = true; }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
  }
  return {
    tasks: result.sort(),
    ...(incomplete ? { reason: "some task ledgers are invalid or inaccessible; task list may be incomplete" } : {}),
  };
}

/** Read existing projections only; registering/selecting never scans or creates tasks. */
export async function projectMetadata(
  paths: KeystonePaths, record: WorkbenchProjectRecord,
): Promise<ScanProjection & { tasks: readonly TaskId[]; reason?: string }> {
  const [profile, taskList] = await Promise.all([scan(paths, record), tasks(paths, record)]);
  return { ...profile, ...taskList };
}
