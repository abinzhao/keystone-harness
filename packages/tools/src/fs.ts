/**
 * Filesystem tools: read, write, delete, list and text search.
 *
 * Every side-effecting call re-checks the lease *before* touching the file, so a
 * write outside scope fails without creating anything — the invariant the PRD
 * states as "范围外写入必须在写之前失败" (EX-03). Reads are bounded and search
 * skips vendored/build output so a single call cannot walk a `node_modules`
 * tree the task never depended on (EX-02, CX-01).
 */

import { access, readFile as readFileAsync, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { globToRegExp, putArtifact, writeFileAtomic } from "@keystone/kernel";
import {
  bool,
  defineSchema,
  int,
  nonEmptyStr,
  objectOf,
  optional,
  str,
  toolDescriptorSchema,
  type InferSchema,
  type ToolDescriptor,
} from "@keystone/schemas";

import {
  TOOL_RESULT_SCHEMA_ID,
  assertLeaseCovers,
  assertWithinRoot,
  errorCodeOf,
  errorMessageOf,
  toRelative,
} from "./guard.ts";
import { type Tool, type ToolResult } from "./types.ts";

/** Directories that are never relevant source: searching them wastes budget and
 * buries real hits (CX-01 keeps context minimal). */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = 2_000_000;
const BINARY_SNIFF_BYTES = 8_192;

const readFileInput = defineSchema(
  "keystone.tool.fs.read_file.input",
  "1.0.0",
  objectOf({
    path: nonEmptyStr(),
    maxBytes: optional(int({ min: 1 })),
  }),
);
type ReadFileArgs = InferSchema<typeof readFileInput>;

export const readFileTool: Tool<ReadFileArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "fs.read_file",
    version: "1.0.0",
    description: "Read a workspace file and return its text, truncated past maxBytes",
    capabilities: ["fs.read"],
    sideEffects: ["none"],
    reversibility: "reversible",
    idempotent: true,
    replayable: true,
    inputSchemaId: readFileInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  }) as ToolDescriptor,
  input: readFileInput.validator,
  async run(args, ctx): Promise<ToolResult> {
    const start = Date.now();
    const absolute = assertWithinRoot(ctx.rootPath, args.path);
    const rel = toRelative(ctx.rootPath, absolute);
    assertLeaseCovers(ctx.lease, { capability: "fs.read", resourceValues: [rel] });

    const limit =
      args.maxBytes ?? ctx.lease.constraints.maxOutputBytes ?? readFileTool.descriptor.maxOutputBytes;
    try {
      const buffer = await readFileAsync(absolute);
      const truncated = buffer.length > limit;
      let artifactId: string | undefined;
      if (truncated) {
        const stored = await putArtifact(ctx.paths, buffer);
        artifactId = stored.artifactId;
      }
      return {
        status: "succeeded",
        stdout: buffer.subarray(0, Math.min(limit, buffer.length)).toString("utf8"),
        outputBytes: buffer.length,
        changedPaths: [],
        durationMs: Date.now() - start,
        truncated,
        ...(artifactId === undefined ? {} : { artifactId }),
      };
    } catch (error) {
      return {
        status: "failed",
        outputBytes: 0,
        changedPaths: [],
        durationMs: Date.now() - start,
        truncated: false,
        errorCode: errorCodeOf(error),
        stderr: errorMessageOf(error),
      };
    }
  },
};

const writeFileInput = defineSchema(
  "keystone.tool.fs.write_file.input",
  "1.0.0",
  objectOf({
    path: nonEmptyStr(),
    content: str(),
    createDirectories: optional(bool()),
  }),
);
type WriteFileArgs = InferSchema<typeof writeFileInput>;

export const writeFileTool: Tool<WriteFileArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "fs.write_file",
    version: "1.0.0",
    description: "Create or overwrite a file inside the workspace",
    capabilities: ["fs.write"],
    sideEffects: ["file_create", "file_modify"],
    // A git worktree can restore the previous bytes, so the change is
    // compensable rather than perfectly reversible.
    reversibility: "compensable",
    idempotent: true,
    replayable: true,
    inputSchemaId: writeFileInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  }) as ToolDescriptor,
  input: writeFileInput.validator,
  async run(args, ctx): Promise<ToolResult> {
    const start = Date.now();
    // Guard first: an out-of-scope or escaping write must fail before any byte
    // reaches the disk (PRD EX-03).
    const absolute = assertWithinRoot(ctx.rootPath, args.path);
    const rel = toRelative(ctx.rootPath, absolute);
    assertLeaseCovers(ctx.lease, { capability: "fs.write", resourceValues: [rel] });

    try {
      if (args.createDirectories === false) {
        await access(dirname(absolute));
      }
      await writeFileAtomic(absolute, args.content);
      return {
        status: "succeeded",
        outputBytes: Buffer.byteLength(args.content, "utf8"),
        changedPaths: [rel],
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (error) {
      return {
        status: "failed",
        outputBytes: 0,
        changedPaths: [],
        durationMs: Date.now() - start,
        truncated: false,
        errorCode: errorCodeOf(error),
        stderr: errorMessageOf(error),
      };
    }
  },
};

const deleteFileInput = defineSchema(
  "keystone.tool.fs.delete_file.input",
  "1.0.0",
  objectOf({ path: nonEmptyStr() }),
);
type DeleteFileArgs = InferSchema<typeof deleteFileInput>;

export const deleteFileTool: Tool<DeleteFileArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "fs.delete_file",
    version: "1.0.0",
    description: "Delete a file inside the workspace",
    capabilities: ["fs.delete"],
    sideEffects: ["file_delete"],
    reversibility: "compensable",
    // Deleting twice is not a no-op: the second call reports a missing file.
    idempotent: false,
    replayable: false,
    inputSchemaId: deleteFileInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  }) as ToolDescriptor,
  input: deleteFileInput.validator,
  async run(args, ctx): Promise<ToolResult> {
    const start = Date.now();
    const absolute = assertWithinRoot(ctx.rootPath, args.path);
    const rel = toRelative(ctx.rootPath, absolute);
    assertLeaseCovers(ctx.lease, { capability: "fs.delete", resourceValues: [rel] });

    try {
      await rm(absolute);
      return {
        status: "succeeded",
        outputBytes: 0,
        changedPaths: [rel],
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (error) {
      return {
        status: "failed",
        outputBytes: 0,
        changedPaths: [],
        durationMs: Date.now() - start,
        truncated: false,
        errorCode: errorCodeOf(error),
        stderr: errorMessageOf(error),
      };
    }
  },
};

const listDirInput = defineSchema(
  "keystone.tool.fs.list_dir.input",
  "1.0.0",
  objectOf({
    path: nonEmptyStr(),
    maxEntries: optional(int({ min: 1 })),
    recursive: optional(bool()),
  }),
);
type ListDirArgs = InferSchema<typeof listDirInput>;

export const listDirTool: Tool<ListDirArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "fs.list_dir",
    version: "1.0.0",
    description: "List entries of a workspace directory",
    capabilities: ["fs.read"],
    sideEffects: ["none"],
    reversibility: "reversible",
    idempotent: true,
    replayable: true,
    inputSchemaId: listDirInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  }) as ToolDescriptor,
  input: listDirInput.validator,
  async run(args, ctx): Promise<ToolResult> {
    const start = Date.now();
    const absolute = assertWithinRoot(ctx.rootPath, args.path);
    const rel = toRelative(ctx.rootPath, absolute);
    assertLeaseCovers(ctx.lease, { capability: "fs.read", resourceValues: [rel] });

    const limit = args.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const lines: string[] = [];
    let truncated = false;

    const collect = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= limit) {
          truncated = true;
          return;
        }
        const child = join(dir, entry.name);
        const childRel = toRelative(ctx.rootPath, resolve(child));
        lines.push(entry.isDirectory() ? `${childRel}/` : childRel);
        if (args.recursive === true && entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) {
          await collect(child);
        }
      }
    };

    try {
      await collect(absolute);
      const stdout = lines.join("\n");
      return {
        status: "succeeded",
        stdout,
        outputBytes: Buffer.byteLength(stdout, "utf8"),
        changedPaths: [],
        durationMs: Date.now() - start,
        truncated,
      };
    } catch (error) {
      return {
        status: "failed",
        outputBytes: 0,
        changedPaths: [],
        durationMs: Date.now() - start,
        truncated: false,
        errorCode: errorCodeOf(error),
        stderr: errorMessageOf(error),
      };
    }
  },
};

const searchTextInput = defineSchema(
  "keystone.tool.fs.search_text.input",
  "1.0.0",
  objectOf({
    pattern: nonEmptyStr(),
    glob: optional(nonEmptyStr()),
    maxResults: optional(int({ min: 1 })),
    caseSensitive: optional(bool()),
  }),
);
type SearchTextArgs = InferSchema<typeof searchTextInput>;

export const searchTextTool: Tool<SearchTextArgs> = {
  descriptor: toolDescriptorSchema.parse({
    id: "fs.search_text",
    version: "1.0.0",
    description: "Search workspace text files for a regular-expression pattern",
    capabilities: ["fs.read"],
    sideEffects: ["none"],
    reversibility: "reversible",
    idempotent: true,
    replayable: true,
    inputSchemaId: searchTextInput.id,
    outputSchemaId: TOOL_RESULT_SCHEMA_ID,
    defaultTimeoutMs: 60_000,
    maxOutputBytes: 1_000_000,
  }) as ToolDescriptor,
  input: searchTextInput.validator,
  async run(args, ctx): Promise<ToolResult> {
    const start = Date.now();
    const glob = args.glob;
    // The lease names the searched area; with no glob the whole workspace is in
    // scope, so the requirement is "**".
    assertLeaseCovers(ctx.lease, { capability: "fs.read", resourceValues: [glob ?? "**"] });

    let matcher: RegExp;
    try {
      matcher = new RegExp(args.pattern, args.caseSensitive === true ? "" : "i");
    } catch (error) {
      return {
        status: "failed",
        outputBytes: 0,
        changedPaths: [],
        durationMs: Date.now() - start,
        truncated: false,
        errorCode: "INVALID_PATTERN",
        stderr: errorMessageOf(error),
      };
    }

    const globMatcher = glob === undefined ? undefined : globToRegExp(glob);
    const limit = args.maxResults ?? DEFAULT_MAX_RESULTS;
    const hits: string[] = [];
    let truncated = false;

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (hits.length >= limit) {
          truncated = true;
          return;
        }
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name)) continue;
          await walk(child);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = toRelative(ctx.rootPath, resolve(child));
        if (globMatcher !== undefined && !globMatcher.test(rel)) continue;

        const info = await stat(child);
        if (info.size > MAX_SEARCH_FILE_BYTES) continue;
        const buffer = await readFileAsync(child);
        if (looksBinary(buffer)) continue;

        const lines = buffer.toString("utf8").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (!matcher.test(line)) continue;
          hits.push(`${rel}:${index + 1}:${line}`);
          if (hits.length >= limit) {
            truncated = true;
            return;
          }
        }
      }
    };

    try {
      await walk(resolve(ctx.rootPath));
      const stdout = hits.join("\n");
      return {
        status: "succeeded",
        stdout,
        outputBytes: Buffer.byteLength(stdout, "utf8"),
        changedPaths: [],
        durationMs: Date.now() - start,
        truncated,
      };
    } catch (error) {
      return {
        status: "failed",
        outputBytes: 0,
        changedPaths: [],
        durationMs: Date.now() - start,
        truncated: false,
        errorCode: errorCodeOf(error),
        stderr: errorMessageOf(error),
      };
    }
  },
};

/** A NUL byte in the sniff window marks a file as binary; decoding it as UTF-8
 * would produce mojibake matches rather than useful results. */
function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export const fsTools: readonly Tool<unknown>[] = [
  readFileTool as unknown as Tool<unknown>,
  writeFileTool as unknown as Tool<unknown>,
  deleteFileTool as unknown as Tool<unknown>,
  listDirTool as unknown as Tool<unknown>,
  searchTextTool as unknown as Tool<unknown>,
];

