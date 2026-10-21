import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync,
  openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sha256Bytes, type Sha256Hex } from "@keystone/schemas";
import { filePath } from "./confinement.ts";
import { FILE_EDIT_MAX_BYTES } from "./content.ts";
import { FileConflictError, FileServiceError, fileError } from "./errors.ts";

export interface EditableFile {
  readonly bytes: Buffer;
  readonly hash: Sha256Hex;
  readonly mode: number;
}

export function editableBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > FILE_EDIT_MAX_BYTES) {
    throw new FileServiceError("file exceeds the editing limit", 413, "file_too_large");
  }
  try {
    if (bytes.includes(0)) throw new Error("NUL");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { throw new FileServiceError("binary files cannot be edited", 415, "binary_file"); }
}

function readEditable(absolute: string, path: string): EditableFile {
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new FileServiceError("expected a regular file");
    if (before.size > FILE_EDIT_MAX_BYTES) throw new FileServiceError("file exceeds the editing limit", 413, "file_too_large");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(absolute);
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev) {
      throw new FileConflictError(path, null, null);
    }
    editableBytes(bytes);
    return { bytes, hash: sha256Bytes(bytes), mode: before.mode & 0o777 };
  } finally { closeSync(fd); }
}

export function editable(root: string, path: string): EditableFile | null {
  const target = filePath(root, path, true);
  if (target.path === ".") throw new FileServiceError("expected a file path");
  try {
    lstatSync(target.absolute);
    return readEditable(target.absolute, target.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fileError(error);
  }
}

export function expectFile(root: string, path: string, hash: string | null, mode?: number): EditableFile | null {
  const current = editable(root, path);
  if ((current?.hash ?? null) !== hash || (mode !== undefined && current?.mode !== mode)) {
    throw new FileConflictError(path, hash, current?.hash ?? null);
  }
  return current;
}

interface FileEffect {
  readonly remove?: { readonly path: string; readonly hash: Sha256Hex; readonly mode: number };
  readonly put?: { readonly path: string; readonly bytes: Uint8Array; readonly mode: number };
}

function cleanup(path: string, directory = false): void {
  try { if (directory) rmdirSync(path); else unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fileError(error);
  }
}

/**
 * No await in the workspace critical section. A captured source is checked
 * again, and hard-link publication is atomic and refuses existing targets.
 */
export function applyFileEffect(root: string, effect: FileEffect): void {
  let stageDir: string | undefined;
  let stage: string | undefined;
  let claimDir: string | undefined;
  let claim: string | undefined;
  let source: string | undefined;
  try {
    if (effect.put !== undefined) {
      const target = filePath(root, effect.put.path, true);
      stageDir = mkdtempSync(join(dirname(target.absolute), ".keystone-edit-"));
      stage = join(stageDir, "content");
      const fd = openSync(stage, "wx", 0o600);
      try {
        writeFileSync(fd, effect.put.bytes);
        fchmodSync(fd, effect.put.mode);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    if (effect.remove !== undefined) {
      expectFile(root, effect.remove.path, effect.remove.hash, effect.remove.mode);
      source = filePath(root, effect.remove.path, true).absolute;
      claimDir = mkdtempSync(join(dirname(source), ".keystone-edit-"));
      const capture = join(claimDir, "original");
      renameSync(source, capture);
      claim = capture;
      const captured = readEditable(claim, effect.remove.path);
      if (captured.hash !== effect.remove.hash || captured.mode !== effect.remove.mode) {
        throw new FileConflictError(effect.remove.path, effect.remove.hash, captured.hash);
      }
    }
    if (effect.put !== undefined) {
      const destination = filePath(root, effect.put.path, true);
      try { linkSync(stage!, destination.absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new FileConflictError(effect.put.path, null, editable(root, effect.put.path)?.hash ?? null);
        }
        throw error;
      }
    }
    if (claim !== undefined) { unlinkSync(claim); claim = undefined; }
  } catch (error) {
    if (claim !== undefined && source !== undefined) {
      try {
        if (filePath(root, effect.remove!.path, true).absolute !== source) throw new Error("source changed");
        linkSync(claim, source);
        unlinkSync(claim);
        claim = undefined;
      } catch {
        throw new FileServiceError(`concurrent edit retained for recovery at "${claim}"`, 409, "file_recovery_required");
      }
    }
    return fileError(error);
  } finally {
    if (stage !== undefined) cleanup(stage);
    if (stageDir !== undefined) cleanup(stageDir, true);
    if (claimDir !== undefined && claim === undefined) cleanup(claimDir, true);
  }
}
