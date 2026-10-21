#!/usr/bin/env node
/**
 * `keystone-desktop` — launch the ordinary-user desktop shell.
 *
 * Spawns the supervised Run Protocol runtime, serves the workbench from a
 * same-origin loopback port, and — on macOS with the compiled helper — presents
 * it in a native WKWebView window (falling back to the system browser when the
 * helper is absent). This entry does not implement any runtime behavior; it
 * wires {@link DesktopShell} to the real keystone home and process signals.
 */

import { resolveKeystonePaths } from "@keystone/kernel";

import { InstanceAlreadyRunningError } from "./single-instance.ts";
import { DesktopShell } from "./shell.ts";

const paths = resolveKeystonePaths(process.env.KEYSTONE_HOME || undefined);
const shell = new DesktopShell({ paths });

try {
  await shell.start();
  process.stderr.write(`Keystone desktop is running at ${shell.origin()}\n`);
} catch (error) {
  if (error instanceof InstanceAlreadyRunningError) {
    // A second launch is not an error: the user already has the window.
    process.stderr.write(`${error.message}\n`);
    process.exit(0);
  }
  process.stderr.write(`Keystone desktop failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
