import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PathEscapeError } from "@keystone/tools";
import { assertWithinRoot } from "../../../tools/src/guard.ts";
import { workbenchPathValidator } from "../../../schemas/src/schemas/workbench.ts";
import { FileServiceError, fileError } from "./errors.ts";

export function canonicalRoot(rootPath: string): string {
  try { return realpathSync(rootPath); } catch (error) { return fileError(error); }
}

export function assertStoreOutsideRoot(root: string, storagePaths: readonly string[]): void {
  for (const store of storagePaths) {
    for (const [parent, child] of [[root, store], [store, root]]) {
      try {
        assertWithinRoot(parent!, child!);
        throw new FileServiceError("workspace and Keystone storage must be separate", 403);
      } catch (error) {
        if (!(error instanceof PathEscapeError)) throw error;
      }
    }
  }
}

export function filePath(root: string, path: string, mutation = false): { absolute: string; path: string } {
  if (!workbenchPathValidator.is(path)) throw new FileServiceError("invalid workspace-relative path");
  try {
    if (realpathSync(root) !== root) throw new FileServiceError("workspace root identity changed", 403);
    const absolute = assertWithinRoot(root, path);
    const normalized = relative(root, absolute).split("\\").join("/") || ".";
    let current = root;
    for (const part of normalized.split("/")) {
      current = join(current, part);
      try {
        const info = lstatSync(current);
        if (info.isSymbolicLink() && mutation) {
          throw new FileServiceError("mutations through symlinks are not supported", 403);
        }
        const real = realpathSync(current);
        if (relative(root, real).split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git")) {
          throw new FileServiceError("Git internals are not exposed", 403);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    return { path: normalized, absolute: mutation ? absolute : resolve(realpathSync(absolute)) };
  } catch (error) {
    if ((error as Error).name === "PathEscapeError") throw new FileServiceError("path escapes the workspace", 403);
    return fileError(error);
  }
}
