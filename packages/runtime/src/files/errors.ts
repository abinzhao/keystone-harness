export class FileServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = "invalid_file_operation") {
    super(message);
    this.name = "FileServiceError";
    this.status = status;
    this.code = code;
  }
}

export class FileConflictError extends FileServiceError {
  readonly path: string;
  readonly expectedHash: string | null;
  readonly actualHash: string | null;
  constructor(path: string, expectedHash: string | null, actualHash: string | null) {
    super(`file "${path}" changed; refresh before retrying`, 409, "file_conflict");
    this.name = "FileConflictError";
    this.path = path;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export function fileError(error: unknown): never {
  if (error instanceof FileServiceError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") throw new FileServiceError("file not found", 404, "file_not_found");
  if (code === "EEXIST") throw new FileConflictError(".", null, null);
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP") {
    throw new FileServiceError("file access denied", 403, "file_access_denied");
  }
  if (code === "EISDIR" || code === "ENOTDIR") throw new FileServiceError("expected a regular file");
  throw new FileServiceError("file operation failed", 500, "file_io_error");
}
