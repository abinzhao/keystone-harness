import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const models = fileURLToPath(new URL("../../models/", import.meta.url));
const args = process.argv.slice(2);
if (process.platform !== "darwin") throw new Error("native carrier build requires macOS and the Swift toolchain");
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out")) throw new Error("usage: build-native.ts [--out directory]");
const output = args[1] ?? join(desktop, "bin");
await mkdir(output, { recursive: true });
const exec = promisify(execFile);
const window = join(output, "keystone-window");
const credentials = join(output, "keystone-credentials");
await exec("swiftc", [join(desktop, "src-native", "KeystoneWindow.swift"),
  "-o", window, "-framework", "Cocoa", "-framework", "WebKit", "-O"], { timeout: 120_000 });
await exec("swiftc", [join(models, "src-native", "KeystoneCredentials.swift"),
  "-o", credentials, "-framework", "Security", "-O"], { timeout: 120_000 });
const contents = join(output, "Keystone.app", "Contents");
await mkdir(join(contents, "MacOS"), { recursive: true });
await mkdir(join(contents, "Helpers"), { recursive: true });
await copyFile(window, join(contents, "MacOS", "keystone-window"));
await copyFile(credentials, join(contents, "Helpers", "keystone-credentials"));
await copyFile(join(desktop, "src-native", "Info.plist"), join(contents, "Info.plist"));
if (args.length === 0) {
  await mkdir(join(models, "bin"), { recursive: true });
  await copyFile(credentials, join(models, "bin", "keystone-credentials"));
}
process.stdout.write(`Native carrier and credential helper built at ${output}\n`);
