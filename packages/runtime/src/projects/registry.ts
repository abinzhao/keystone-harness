import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { projectIdForWorkspace, withLock, writeFileAtomic, type KeystonePaths } from "@keystone/kernel";
import { canonicalJson, nowIso } from "@keystone/schemas";
import { PathEscapeError } from "@keystone/tools";
import { assertWithinRoot } from "../../../tools/src/guard.ts";
import {
  projectRegisterSchema, projectRegistrySchema, projectUpdateSchema, workbenchProjectRecordSchema,
  workbenchProjectSchema, type ProjectRegisterInput, type ProjectUpdateInput, type WorkbenchProject,
  type WorkbenchProjectRecord,
} from "../../../schemas/src/schemas/workbench.ts";
import { readGit } from "./git.ts";
import { projectIdValidator } from "../../../schemas/src/schemas/ids.ts";
import { projectMetadata } from "./projections.ts";

export class ProjectServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = "invalid_project") {
    super(message);
    this.name = "ProjectServiceError";
    this.status = status;
    this.code = code;
  }
}

export class ProjectRegistry {
  private readonly paths: KeystonePaths;
  constructor(paths: KeystonePaths) { this.paths = paths; }

  private file(): string { return join(this.paths.projectsDir, "registry.json"); }

  private id(projectId: string): void {
    if (!projectIdValidator.is(projectId)) throw new ProjectServiceError("invalid projectId");
  }

  private locked<T>(effect: () => Promise<T>): Promise<T> {
    return withLock(`${this.file()}.lock`, { holder: "workbench.project.registry" }, effect);
  }

  private async root(path: string): Promise<string> {
    if (!isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) {
      throw new ProjectServiceError("rootPath must be an absolute path without traversal");
    }
    try {
      const root = await realpath(path);
      const top = await realpath((await readGit(root, ["rev-parse", "--show-toplevel"])).trim());
      if (root !== top) throw new ProjectServiceError("rootPath must name the Git worktree root");
      for (const [parent, child] of [[root, this.paths.home], [this.paths.home, root]]) {
        try {
          assertWithinRoot(parent!, child!);
          throw new ProjectServiceError("workspace and Keystone storage must be separate");
        } catch (error) {
          if (!(error instanceof PathEscapeError)) throw error;
        }
      }
      return root;
    } catch (error) {
      if (error instanceof ProjectServiceError) throw error;
      throw new ProjectServiceError("rootPath is not an accessible Git worktree root");
    }
  }

  private async records(): Promise<readonly WorkbenchProjectRecord[]> {
    try {
      return projectRegistrySchema.parse(JSON.parse(await readFile(this.file(), "utf8"))).projects;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ProjectServiceError("project registry is invalid or inaccessible", 500, "project_registry_invalid");
    }
  }

  private async project(record: WorkbenchProjectRecord): Promise<WorkbenchProject> {
    const base = { ...record, ...await projectMetadata(this.paths, record) };
    try {
      if (await realpath(record.rootPath) !== record.rootPath) {
        throw new ProjectServiceError("workspace root identity changed");
      }
      await this.root(record.rootPath);
      const branch = (await readGit(record.rootPath, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        .catch(() => "")).trim() || null;
      const status = await readGit(record.rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      return workbenchProjectSchema.parse({ ...base, status: "available", branch, dirty: status.length > 0 });
    } catch (error) {
      return workbenchProjectSchema.parse({
        ...base, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable",
        branch: null, dirty: null, reason: "workspace is missing or no longer an accessible Git root",
      });
    }
  }

  async list(): Promise<readonly WorkbenchProject[]> {
    return Promise.all((await this.records()).map((record) => this.project(record)));
  }

  async get(projectId: string): Promise<WorkbenchProject | undefined> {
    this.id(projectId);
    const record = (await this.records()).find((project) => project.projectId === projectId);
    return record === undefined ? undefined : this.project(record);
  }

  async register(input: ProjectRegisterInput): Promise<WorkbenchProject> {
    let parsed: ProjectRegisterInput;
    try { parsed = projectRegisterSchema.parse(input); } catch { throw new ProjectServiceError("invalid registration input"); }
    const rootPath = await this.root(parsed.rootPath);
    const projectId = await projectIdForWorkspace(rootPath);
    return this.locked(async () => {
      const records = await this.records();
      const existing = records.find((record) => record.rootPath === rootPath);
      if (existing !== undefined) return this.project(existing);
      if (records.some((record) => record.projectId === projectId || record.workspaceId === projectId)) {
        throw new ProjectServiceError("workspace identity is reserved; reconnect the existing project", 409, "duplicate_workspace");
      }
      const record = workbenchProjectRecordSchema.parse({
        projectId, workspaceId: projectId, rootPath, name: parsed.name ?? basename(rootPath),
        pinned: false, archived: false, createdAt: nowIso(), updatedAt: nowIso(),
      });
      await writeFileAtomic(this.file(), canonicalJson({ version: "1.0.0", projects: [...records, record] }));
      return this.project(record);
    });
  }

  async update(projectId: string, input: ProjectUpdateInput): Promise<WorkbenchProject> {
    this.id(projectId);
    let parsed: ProjectUpdateInput;
    try { parsed = projectUpdateSchema.parse(input); } catch { throw new ProjectServiceError("invalid project update"); }
    const rootPath = parsed.rootPath === undefined ? undefined : await this.root(parsed.rootPath);
    const workspaceId = rootPath === undefined ? undefined : await projectIdForWorkspace(rootPath);
    return this.locked(async () => {
      const records = await this.records();
      const existing = records.find((record) => record.projectId === projectId);
      if (existing === undefined) throw new ProjectServiceError("project not found", 404, "project_not_found");
      if (rootPath !== undefined && records.some((record) => record.projectId !== projectId &&
          (record.rootPath === rootPath || record.projectId === workspaceId || record.workspaceId === workspaceId))) {
        throw new ProjectServiceError("workspace is already registered", 409, "duplicate_workspace");
      }
      const updated = workbenchProjectRecordSchema.parse({
        ...existing, ...parsed, ...(rootPath === undefined ? {} : { rootPath, workspaceId }),
        updatedAt: nowIso(),
      });
      await writeFileAtomic(this.file(), canonicalJson({
        version: "1.0.0", projects: records.map((record) => record === existing ? updated : record),
      }));
      return this.project(updated);
    });
  }

  async remove(projectId: string): Promise<{ projectId: string; removed: true }> {
    this.id(projectId);
    return this.locked(async () => {
      const records = await this.records();
      if (!records.some((record) => record.projectId === projectId)) {
        throw new ProjectServiceError("project not found", 404, "project_not_found");
      }
      await writeFileAtomic(this.file(), canonicalJson({
        version: "1.0.0", projects: records.filter((record) => record.projectId !== projectId),
      }));
      return { projectId, removed: true };
    });
  }
}
