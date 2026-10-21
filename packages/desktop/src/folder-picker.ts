/**
 * Native folder-selection bridge.
 *
 * The workbench needs a workspace path. A desktop user expects a "Choose folder…"
 * panel, not to type an absolute path. This shells out to the platform chooser
 * and returns a POSIX path. It is read-only: it opens no project and changes no
 * state; the user still confirms the chosen folder in the composer.
 *
 * macOS uses AppleScript's `choose folder` via the bundled `osascript`. On other
 * platforms this slice has no bridge, so it reports itself as unsupported rather
 * than guessing — typing a path always works (ADR-0008, Decision D).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface FolderPickResult {
  /** False when the platform has no chooser in this slice, or the user cancelled. */
  readonly supported: boolean;
  readonly cancelled?: boolean;
  /** The chosen absolute POSIX path, when one was picked. */
  readonly path?: string;
  readonly error?: string;
}

/** Whether this platform can show a native chooser at all. */
export function folderPickerSupported(): boolean {
  return process.platform === "darwin";
}

export async function chooseFolder(prompt = "Choose a project folder"): Promise<FolderPickResult> {
  if (!folderPickerSupported()) {
    return {
      supported: false,
      error: "the native folder picker is only available on macOS in this build; type a path instead",
    };
  }
  try {
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`;
    const { stdout } = await exec("osascript", ["-e", script], { timeout: 120_000 });
    const path = stdout.trim().replace(/\/$/, "");
    if (path === "") return { supported: true, cancelled: true };
    return { supported: true, path };
  } catch (error) {
    // User cancellation is osascript exit code 1 / User canceled — that is not an
    // error, just "no folder".
    const code = (error as { code?: number }).code;
    if (code === 1) return { supported: true, cancelled: true };
    return {
      supported: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
