/**
 * Native-window launcher for the desktop shell (ADR-0008, Decision H).
 *
 * The window is a tiny compiled WKWebView host (`bin/keystone-window`, built
 * from `src-native/KeystoneWindow.swift` with the system Swift toolchain). It
 * is a *view*: it takes the shell origin URL on its command line, renders it
 * in a titled macOS window, and exits when the window closes. The shell — not
 * the window — owns the runtime child, the token, and all state.
 *
 * Capability is resolved loudly, not guessed:
 *  - non-macOS → unsupported (the system-browser fallback keeps working);
 *  - macOS without the compiled helper → unsupported, and the shell falls back
 *    to the system browser rather than silently pretending to be native.
 *
 * The helper path is resolved relative to this source file so both the dev
 * layout (`packages/desktop/src/`) and a packaged layout work unchanged.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the compiled native window helper. */
export function windowHelperPath(): string {
  return join(HERE, "..", "bin", "keystone-window");
}

/**
 * Whether a native window can be opened *right now*: we are on macOS and the
 * compiled helper binary exists. Anything else is an explicit "no", never a
 * guess — the caller then takes the documented system-browser fallback.
 */
export function nativeWindowSupported(options: { helperPath?: string } = {}): boolean {
  if (process.platform !== "darwin") return false;
  return existsSync(options.helperPath ?? windowHelperPath());
}

export interface WindowLaunchOptions {
  /** Override the helper location (tests / packaged layouts). */
  readonly helperPath?: string;
  readonly title?: string;
}

export interface WindowLaunch {
  readonly process: ChildProcess;
}

/**
 * Launch the native window pointed at `url`. The returned process is
 * supervised by the shell: its exit means the user closed the window.
 *
 * Throws when the platform/helper is unavailable — callers must check
 * {@link nativeWindowSupported} first (this is deliberate: a silent browser
 * fallback where a native window was promised would violate I8's
 * "degradation is loud").
 */
export function launchNativeWindow(url: string, options: WindowLaunchOptions = {}): WindowLaunch {
  const helperPath = options.helperPath ?? windowHelperPath();
  if (process.platform !== "darwin") {
    throw new Error("the native window is only available on macOS");
  }
  if (!existsSync(helperPath)) {
    throw new Error(
      `the native window helper is not built at ${helperPath} ` +
        "(run `swiftc src-native/KeystoneWindow.swift -o bin/keystone-window -framework Cocoa -framework WebKit` " +
        "or fall back to the system browser)",
    );
  }
  const args = [url];
  if (options.title !== undefined) args.push("--title", options.title);
  const windowProcess = spawn(helperPath, args, { stdio: "ignore", detached: false });
  return { process: windowProcess };
}
