import type { JsonValue } from "@keystone/schemas";
import type { KeystonePaths } from "@keystone/kernel";
import {
  fileReadInputSchema, fileReadSchema, type FileRead, type FileReadInput,
  type FileSearch, type FileSearchInput, type FileTree, type FileTreeInput, type FileMutation, type FileMutationInput,
} from "../../../schemas/src/schemas/workbench.ts";
import { assertStoreOutsideRoot, canonicalRoot, filePath } from "./confinement.ts";
import { readContent } from "./content.ts";
import { FileServiceError } from "./errors.ts";
import { FileMutations } from "./mutations.ts";
import { search, tree } from "./projections.ts";
export { FileConflictError, FileServiceError } from "./errors.ts";
export { FILE_READ_MAX_BYTES, FILE_EDIT_MAX_BYTES } from "./content.ts";
export { FILE_SEARCH_MAX_RESULTS } from "./projections.ts";
export type { FileMutation, FileMutationInput } from "../../../schemas/src/schemas/workbench.ts";

export interface FileMutationBoundaryRequest {
  readonly operation: "write" | "create" | "rename" | "delete" | "undo";
  readonly path: string;
  readonly destination?: string;
  readonly parameters: Record<string, JsonValue>;
}

/** The controller authorizes, invokes the effect, and records its kernel result. */
export interface FileMutationBoundary {
  execute<T>(request: FileMutationBoundaryRequest, effect: () => Promise<T>): Promise<T>;
}

export interface FileWorkspaceOptions {
  readonly rootPath: string;
  readonly paths: KeystonePaths;
  readonly boundary: FileMutationBoundary;
}

export class FileWorkspaceService {
  private readonly options: FileWorkspaceOptions;
  private readonly root: string;
  constructor(options: FileWorkspaceOptions) {
    this.options = options;
    this.root = canonicalRoot(options.rootPath);
    assertStoreOutsideRoot(this.root, [options.paths.home, options.paths.artifactsDir]);
  }

  async read(input: FileReadInput): Promise<FileRead> {
    let args: FileReadInput;
    try { args = fileReadInputSchema.parse(input); } catch { throw new FileServiceError("invalid read input"); }
    const target = filePath(this.root, args.path);
    const content = await readContent(target.absolute, target.path);
    return fileReadSchema.parse({
      path: target.path, content: content.content, hash: content.hash,
      size: content.size, binary: content.binary, truncated: content.truncated,
    });
  }

  tree(input: FileTreeInput = {}): Promise<FileTree> { return tree(this.root, input); }

  search(input: FileSearchInput): Promise<FileSearch> { return search(this.root, input); }

  mutate(input: FileMutationInput): Promise<FileMutation> {
    return new FileMutations(this.root, this.options.paths, this.options.boundary).mutate(input);
  }
}
