import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getArtifactBytes, putArtifact, withLock, writeFileAtomic, type KeystonePaths } from "@keystone/kernel";
import { canonicalJson, sha256Bytes, sha256Hex, type JsonValue } from "@keystone/schemas";
import {
  fileMutationInputSchema, fileMutationRecordSchema, fileMutationSchema,
  type FileMutation, type FileMutationInput, type FileMutationRecord,
} from "../../../schemas/src/schemas/workbench.ts";
import { applyFileEffect, editableBytes, expectFile, type EditableFile } from "./atomic.ts";
import { assertStoreOutsideRoot, filePath } from "./confinement.ts";
import { FileConflictError, FileServiceError, fileError } from "./errors.ts";
import type { FileMutationBoundary, FileMutationBoundaryRequest } from "./service.ts";

export class FileMutations {
  private readonly root: string;
  private readonly paths: KeystonePaths;
  private readonly boundary: FileMutationBoundary;
  constructor(root: string, paths: KeystonePaths, boundary: FileMutationBoundary) {
    this.root = root;
    this.paths = paths;
    this.boundary = boundary;
  }

  private directory(): string { return join(this.paths.home, "file-mutations", sha256Hex(this.root)); }
  private recordPath(id: string): string { return join(this.directory(), `${id}.json`); }
  private async record(id: string): Promise<FileMutationRecord> {
    try {
      const record = fileMutationRecordSchema.parse(JSON.parse(await readFile(this.recordPath(id), "utf8")));
      if (record.rootPath !== this.root) throw new FileServiceError("mutation belongs to another workspace", 403);
      return record;
    } catch (error) {
      if (error instanceof FileServiceError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fileError(error);
      throw new FileServiceError("invalid mutation record", 500, "mutation_record_invalid");
    }
  }

  private execute(request: FileMutationBoundaryRequest, effect: () => Promise<FileMutation>): Promise<FileMutation> {
    let invoked = false;
    return this.boundary.execute(Object.freeze({ ...request, parameters: Object.freeze(request.parameters) }), async () => {
      if (invoked) throw new FileServiceError("mutation effect already invoked", 409);
      invoked = true;
      assertStoreOutsideRoot(this.root, [this.paths.home, this.paths.artifactsDir]);
      return withLock(join(this.directory(), "workspace.lock"), { holder: "workbench.file.mutation" }, effect);
    });
  }

  async mutate(input: FileMutationInput): Promise<FileMutation> {
    assertStoreOutsideRoot(this.root, [this.paths.home, this.paths.artifactsDir]);
    let args: FileMutationInput;
    try { args = fileMutationInputSchema.parse(input); } catch { throw new FileServiceError("invalid mutation input"); }
    const path = filePath(this.root, args.path, true).path;
    if (path === ".") throw new FileServiceError("expected a file path");
    if (args.operation === "undo") return this.undo({ ...args, path });

    const destination = args.operation === "rename" ? filePath(this.root, args.destination, true).path : undefined;
    if (destination === "." || destination === path) throw new FileServiceError("invalid rename destination");
    const expectedHash = args.operation === "create" ? null : args.expectedHash;
    const before = expectFile(this.root, path, expectedHash);
    if (destination !== undefined) expectFile(this.root, destination, null);
    const bytes = "content" in args ? Buffer.from(args.content, "utf8") : undefined;
    if (bytes !== undefined) editableBytes(bytes);
    const record = fileMutationRecordSchema.parse({
      mutationId: `mut_${randomUUID()}`, rootPath: this.root, operation: args.operation,
      path, ...(destination === undefined ? {} : { destination }),
      beforeHash: before?.hash ?? null,
      afterHash: args.operation === "delete" ? null : bytes === undefined ? before!.hash : sha256Bytes(bytes),
      artifactId: before === null ? null : `art_${before.hash}`,
      mode: before?.mode ?? 0o644, state: "prepared",
    });
    const parameters: Record<string, JsonValue> = {
      operation: args.operation, path, expectedHash,
      mutationId: record.mutationId, artifactId: record.artifactId, mode: record.mode,
      ...(destination === undefined ? {} : { destination }),
      ...("content" in args ? { content: args.content } : {}),
    };
    return this.execute({ operation: args.operation, path, ...(destination === undefined ? {} : { destination }), parameters },
      async () => {
        expectFile(this.root, path, expectedHash, before?.mode);
        if (destination !== undefined) expectFile(this.root, destination, null);
        if (before !== null) await putArtifact(this.paths, before.bytes);
        await writeFileAtomic(this.recordPath(record.mutationId), canonicalJson(record));
        expectFile(this.root, path, expectedHash, before?.mode);
        if (destination !== undefined) expectFile(this.root, destination, null);
        applyFileEffect(this.root, {
          ...(before === null ? {} : { remove: { path, hash: before.hash, mode: before.mode } }),
          ...(args.operation === "delete" ? {} : {
            put: { path: destination ?? path, bytes: bytes ?? before!.bytes, mode: record.mode },
          }),
        });
        await writeFileAtomic(this.recordPath(record.mutationId), canonicalJson({ ...record, state: "applied" }));
        return this.result(record, args.operation, record.afterHash);
      });
  }

  private result(
    record: FileMutationRecord, operation: FileMutation["operation"], hash: FileMutation["hash"],
    artifactId: FileMutation["artifactId"] = record.artifactId,
  ): FileMutation {
    return fileMutationSchema.parse({
      mutationId: record.mutationId, operation, path: record.path,
      ...(record.destination === undefined ? {} : { destination: record.destination }),
      hash, artifactId,
      changedPaths: record.destination === undefined ? [record.path] : [record.path, record.destination],
    });
  }

  private async undo(args: Extract<FileMutationInput, { operation: "undo" }>): Promise<FileMutation> {
    const record = await this.record(args.mutationId);
    if (record.path !== args.path) throw new FileServiceError("mutation path does not match", 403);
    if (record.state !== "applied") throw new FileConflictError(args.path, args.expectedHash, null);
    const currentPath = record.destination ?? record.path;
    if (args.expectedHash !== record.afterHash) {
      throw new FileConflictError(currentPath, args.expectedHash, record.afterHash);
    }
    const check = (): EditableFile | null => {
      if (record.destination !== undefined) expectFile(this.root, record.path, null);
      return expectFile(this.root, currentPath, args.expectedHash, args.expectedHash === null ? undefined : record.mode);
    };
    const beforeUndo = check();
    const undoArtifactId = beforeUndo === null ? null : `art_${beforeUndo.hash}`;
    const bytes = record.artifactId === null ? undefined : await getArtifactBytes(this.paths, record.artifactId);
    if (record.artifactId !== null && (bytes === undefined || sha256Bytes(bytes) !== record.beforeHash ||
        record.artifactId !== `art_${record.beforeHash}`)) {
      throw new FileServiceError("compensating artifact is missing or corrupt", 409, "mutation_artifact_invalid");
    }
    if (bytes !== undefined) editableBytes(bytes);
    const parameters: Record<string, JsonValue> = {
      operation: "undo", path: args.path, mutationId: args.mutationId, expectedHash: args.expectedHash,
      artifactId: record.artifactId, compensationArtifactId: undoArtifactId, beforeHash: record.beforeHash, mode: record.mode,
      ...(record.destination === undefined ? {} : { destination: record.destination }),
    };
    return this.execute({
      operation: "undo", path: record.path,
      ...(record.destination === undefined ? {} : { destination: record.destination }), parameters,
    }, async () => {
      if (canonicalJson(await this.record(args.mutationId)) !== canonicalJson(record)) {
        throw new FileConflictError(args.path, args.expectedHash, null);
      }
      const current = check();
      if (current !== null) await putArtifact(this.paths, current.bytes);
      applyFileEffect(this.root, {
        ...(current === null ? {} : { remove: { path: currentPath, hash: current.hash, mode: current.mode } }),
        ...(bytes === undefined ? {} : { put: { path: record.path, bytes, mode: record.mode } }),
      });
      const undone = fileMutationRecordSchema.parse({ ...record, state: "undone", undoArtifactId });
      await writeFileAtomic(this.recordPath(record.mutationId), canonicalJson(undone));
      return this.result(record, "undo", record.beforeHash, undone.undoArtifactId ?? null);
    });
  }
}
