/**
 * `@keystone/desktop` — the thin desktop shell.
 *
 * Composition only: a supervised loopback Run Protocol runtime behind a
 * same-origin proxy, plus the first-run BYOK onboarding bridge. It intentionally
 * does not re-export runtime or kernel internals; the shell composes them, it
 * does not re-implement them (ADR-0008).
 */

export { DesktopShell, type DesktopShellOptions, type RuntimeTarget } from "./shell.ts";
export { DesktopConfigBridge, type BootstrapInfo, type ModelSummary } from "./config-bridge.ts";
export { chooseFolder, folderPickerSupported, type FolderPickResult } from "./folder-picker.ts";
export {
  acquireInstanceLock,
  InstanceAlreadyRunningError,
  type InstanceLock,
} from "./single-instance.ts";
export {
  launchNativeWindow,
  nativeWindowSupported,
  windowHelperPath,
  type WindowLaunch,
  type WindowLaunchOptions,
} from "./window.ts";
