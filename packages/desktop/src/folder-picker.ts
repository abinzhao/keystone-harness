/** NSOpenPanel selection only; opening a workspace remains a separate user action. */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { nativeWindowSupported, windowHelperPath } from "./window.ts";

const exec = promisify(execFile);

export interface FolderPickResult {
  readonly supported: boolean;
  readonly cancelled?: boolean;
  readonly path?: string;
  readonly error?: string;
}

export interface FolderPickerOptions {
  readonly helperPath?: string;
  readonly invoke?: (helperPath: string, args: readonly string[]) => Promise<{ readonly stdout: string }>;
}

export function folderPickerSupported(options: FolderPickerOptions = {}): boolean {
  return nativeWindowSupported(options);
}

export async function chooseFolder(
  prompt = "Choose a project folder", options: FolderPickerOptions = {},
): Promise<FolderPickResult> {
  if (!folderPickerSupported(options)) return {
    supported: false, error: "native folder picker unavailable; build the macOS helper or type a path",
  };
  try {
    const invoke = options.invoke ?? ((helperPath, args) => exec(helperPath, [...args], {
      timeout: 120_000, maxBuffer: 65_536,
    }));
    const { stdout } = await invoke(options.helperPath ?? windowHelperPath(), ["--pick-folder", "--prompt", prompt]);
    const result: unknown = JSON.parse(stdout);
    if (typeof result !== "object" || result === null) throw new Error();
    const value = result as Record<string, unknown>;
    if (value["supported"] !== true) throw new Error();
    if (value["cancelled"] === true) return { supported: true, cancelled: true };
    if (typeof value["path"] !== "string" || !isAbsolute(value["path"])) throw new Error();
    return { supported: true, path: value["path"] };
  } catch { return { supported: true, error: "native folder selection failed; type a path instead" }; }
}
