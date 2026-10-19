/**
 * Cross-platform spawn target resolution.
 *
 * A pure, side-effect-free helper shared by the two execution boundaries
 * (`@keystone/tools`'s `spawnCapture` and `@keystone/verifiers`'s
 * `runCaptured`). It computes *how* to launch a command; it never launches one,
 * so it stays out of the kernel's state authority and can be unit tested for
 * any platform by passing `platform` explicitly.
 *
 * Why it exists: on Windows the package-manager launchers a verifier relies on
 * (`npm`, `pnpm`, `yarn`, `npx`) are not executables but `.cmd` shims. Two
 * problems follow, and both must be handled or Windows support is a lie:
 *
 *  1. `CreateProcess` only appends `.exe` to an extension-less name, so a bare
 *     `pnpm` is never found — the `.cmd` suffix is required.
 *  2. Since Node 18.20 / 20.12 / 21.7 (CVE-2024-27980) `spawn('x.cmd', …)` with
 *     `shell: false` throws `EINVAL` outright, so a `.cmd` must be run through
 *     the command processor.
 *
 * Running through `cmd.exe` is the one place a shell re-enters the model, so it
 * is confined to this module and compensated for: the "no shell" guarantee is
 * preserved by escaping every argument for `cmd.exe` before it is handed over
 * (the escaping algorithm is ported from cross-spawn, MIT, itself based on
 * https://qntm.org/cmd). Native executables (`node`, `git`, real `.exe`/`.com`
 * files) are launched directly, exactly as on POSIX.
 */

/** Launchers that exist only as a `.cmd`/`.bat` shim on Windows. */
const WINDOWS_SHIM_LAUNCHERS: ReadonlySet<string> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "corepack",
]);

const CMD_OR_BAT = /\.(cmd|bat)$/i;

/** `cmd.exe` metacharacters, from http://www.robvanderwoude.com/escapechars.php */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** Escape the command word itself (never quoted; inner quotes would break `/s`). */
function escapeCommand(arg: string): string {
  return arg.replace(CMD_META_CHARS, "^$1");
}

/**
 * Quote and escape one argument so `cmd.exe` reproduces the exact string.
 * Ported verbatim from cross-spawn's `escape.argument`; `doubleEscapeMetaChars`
 * is off because the launchers we wrap are PATH-resolved (e.g. `npm.cmd` in
 * `%APPDATA%\npm`), not `node_modules/.bin` cmd-shims.
 */
function escapeArgument(arg: string): string {
  let value = `${arg}`;
  // Backslashes immediately before a double quote: double them, escape the quote.
  value = value.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  // Backslashes at the end of the string: double them (a quote follows).
  value = value.replace(/(?=(\\+?)?)\1$/, "$1$1");
  value = `"${value}"`;
  value = value.replace(CMD_META_CHARS, "^$1");
  return value;
}

export interface SpawnTarget {
  /** The executable to hand to `spawn`. */
  readonly command: string;
  /** The arguments to hand to `spawn`, already adjusted for the platform. */
  readonly args: readonly string[];
  /**
   * `spawn`'s `windowsVerbatimArguments`: true only when we pre-escaped the
   * arguments for `cmd.exe`, so Node must not quote them a second time.
   */
  readonly windowsVerbatimArguments: boolean;
}

export interface ResolveSpawnTargetOptions {
  /** Defaults to `process.platform`. Injected in tests. */
  readonly platform?: string;
  /** The Windows command processor. Defaults to `%ComSpec%`, then `cmd.exe`. */
  readonly comspec?: string;
  /** Environment used only to read `ComSpec`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  options: ResolveSpawnTargetOptions = {},
): SpawnTarget {
  const platform = options.platform ?? process.platform;

  // POSIX is passed through untouched: the caller's "no shell, args as array"
  // contract is already exactly what the kernel will run.
  if (platform !== "win32") {
    return { command, args: [...args], windowsVerbatimArguments: false };
  }

  if (!needsCommandProcessor(command)) {
    // A native executable, or a bare name Windows will resolve by appending
    // `.exe`. Launched directly, keeping the no-shell path.
    return { command, args: [...args], windowsVerbatimArguments: false };
  }

  const env = options.env ?? process.env;
  const comspec = options.comspec ?? env["ComSpec"] ?? env["COMSPEC"] ?? "cmd.exe";
  const executable = CMD_OR_BAT.test(command) ? command : `${command}.cmd`;
  const shellCommand = [escapeCommand(executable), ...args.map(escapeArgument)].join(" ");

  return {
    command: comspec,
    // `/d` skips AutoRun, `/s` + outer quotes make the rest a single literal
    // command line, `/c` runs it and exits.
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

/** True when the command cannot be launched by `CreateProcess` alone. */
function needsCommandProcessor(command: string): boolean {
  if (CMD_OR_BAT.test(command)) return true;
  // Only a bare launcher name is looked up on PATH; a path with a separator is
  // left alone so a caller naming `C:\tool\app.exe` is not wrapped.
  if (command.includes("/") || command.includes("\\")) return false;
  return WINDOWS_SHIM_LAUNCHERS.has(command.toLowerCase());
}
