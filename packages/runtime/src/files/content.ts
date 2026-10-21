import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { sha256Validator } from "../../../schemas/src/schemas/ids.ts";
import { FileConflictError, FileServiceError, fileError } from "./errors.ts";

export const FILE_READ_MAX_BYTES = 1_048_576;
export const FILE_EDIT_MAX_BYTES = 2_000_000;

export async function readContent(absolute: string, path: string, limit = FILE_READ_MAX_BYTES) {
  try {
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new FileServiceError("expected a regular file");
      const digest = createHash("sha256");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let binary = false;
      let offset = 0;
      const buffer = Buffer.alloc(65_536);
      const chunks: Buffer[] = [];
      while (offset < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (bytesRead === 0) break;
        const bytes = buffer.subarray(0, bytesRead);
        digest.update(bytes);
        if (bytes.includes(0)) binary = true;
        if (!binary) {
          try { decoder.decode(bytes, { stream: true }); } catch { binary = true; }
        }
        if (offset < limit) chunks.push(Buffer.from(bytes.subarray(0, Math.min(bytesRead, limit - offset))));
        offset += bytesRead;
      }
      if (!binary) {
        try { decoder.decode(); } catch { binary = true; }
      }
      const after = await handle.stat();
      const current = await lstat(absolute);
      if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev) {
        throw new FileConflictError(path, null, null);
      }
      const bytes = Buffer.concat(chunks);
      const truncated = before.size > limit;
      const content = binary ? "" : new TextDecoder().decode(bytes, { stream: truncated });
      return {
        content, bytes, hash: sha256Validator.parse(digest.digest("hex")),
        size: before.size, binary, truncated, mode: before.mode & 0o777,
      };
    } finally { await handle.close(); }
  } catch (error) { return fileError(error); }
}
