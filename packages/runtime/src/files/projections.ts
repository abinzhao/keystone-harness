import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  fileSearchInputSchema, fileSearchSchema, fileTreeInputSchema, fileTreeSchema,
  workbenchPathValidator, type FileEntry, type FileSearch, type FileSearchInput,
  type FileTree, type FileTreeInput,
} from "../../../schemas/src/schemas/workbench.ts";
import { readGit } from "../projects/git.ts";
import { filePath } from "./confinement.ts";
import { FILE_EDIT_MAX_BYTES, readContent } from "./content.ts";
import { FileServiceError, fileError } from "./errors.ts";

const SEARCH_SKIP = new Set([".git", "node_modules", "dist", "build", "coverage"]);
export const FILE_SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_ENTRIES = 10_000;

async function gitStatuses(root: string): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await readGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch { throw new FileServiceError("Git status is unavailable", 503, "git_unavailable"); }
  const records = text.split("\0");
  const statuses = new Map<string, string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    const status = record.slice(0, 2);
    statuses.set(record.slice(3), status);
    if (status.includes("R") || status.includes("C")) {
      const source = records[++index];
      if (source !== undefined) statuses.set(source, status);
    }
  }
  return statuses;
}

export async function tree(root: string, input: FileTreeInput = {}): Promise<FileTree> {
  let args: FileTreeInput;
  try { args = fileTreeInputSchema.parse(input); } catch { throw new FileServiceError("invalid tree input"); }
  const target = filePath(root, args.path ?? ".");
  try {
    if (!(await lstat(target.absolute)).isDirectory()) throw new FileServiceError("expected a directory");
    const names = (await readdir(target.absolute)).filter((name) => name.toLowerCase() !== ".git").sort();
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 200;
    const statuses = await gitStatuses(root);
    const entries: FileEntry[] = [];
    for (const name of names.slice(offset, offset + limit)) {
      const path = target.path === "." ? name : `${target.path}/${name}`;
      if (!workbenchPathValidator.is(path)) throw new FileServiceError("directory contains unsupported path syntax");
      const info = await lstat(join(target.absolute, name));
      if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) continue;
      const childStatus = [...statuses].find(([key]) => key.startsWith(`${path}/`))?.[1];
      entries.push({
        path, name, kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file",
        size: info.isDirectory() ? 0 : info.size, gitStatus: statuses.get(path) ?? childStatus ?? "",
      });
    }
    return fileTreeSchema.parse({ entries, nextOffset: offset + limit < names.length ? offset + limit : null });
  } catch (error) { return fileError(error); }
}

export async function search(root: string, input: FileSearchInput): Promise<FileSearch> {
  let args: FileSearchInput;
  try { args = fileSearchInputSchema.parse(input); } catch { throw new FileServiceError("invalid search input"); }
  const results: FileSearch["results"][number][] = [];
  let truncated = false;
  let visited = 0;
  const walk = async (path: string): Promise<void> => {
    const directory = filePath(root, path);
    const entries = (await readdir(directory.absolute, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (++visited > SEARCH_MAX_ENTRIES) { truncated = true; return; }
      if (SEARCH_SKIP.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
      const child = path === "." ? entry.name : `${path}/${entry.name}`;
      if (!workbenchPathValidator.is(child)) { truncated = true; continue; }
      if (entry.isDirectory()) {
        await walk(child);
        if (results.length > FILE_SEARCH_MAX_RESULTS || visited > SEARCH_MAX_ENTRIES) return;
        continue;
      }
      if (!entry.isFile()) continue;
      const target = filePath(root, child);
      const info = await lstat(target.absolute);
      if (info.size > FILE_EDIT_MAX_BYTES) { truncated = true; continue; }
      const content = await readContent(target.absolute, child, FILE_EDIT_MAX_BYTES);
      if (content.binary) continue;
      const lines = content.content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index]!;
        if (!text.includes(args.q)) continue;
        if (text.length > 4096) truncated = true;
        results.push({ path: child, line: index + 1, text: text.slice(0, 4096) });
        if (results.length > FILE_SEARCH_MAX_RESULTS) { truncated = true; return; }
      }
    }
  };
  try {
    await walk(".");
    return fileSearchSchema.parse({ results: results.slice(0, FILE_SEARCH_MAX_RESULTS), truncated });
  } catch (error) { return fileError(error); }
}
