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
const sdk = (await exec("xcrun", ["--sdk", "macosx", "--show-sdk-path"])).stdout.trim();
for (const arch of ["arm64", "x86_64"]) {
  await exec("swiftc", [join(desktop, "src-native", "KeystoneWindow.swift"),
    "-target", `${arch}-apple-macos11.0`, "-sdk", sdk,
    "-o", `${window}-${arch}`, "-framework", "Cocoa", "-framework", "WebKit", "-O"], { timeout: 120_000 });
  await exec("swiftc", [join(models, "src-native", "KeystoneCredentials.swift"),
    "-target", `${arch}-apple-macos11.0`, "-sdk", sdk,
    "-o", `${credentials}-${arch}`, "-framework", "Security", "-O"], { timeout: 120_000 });
}
await exec("lipo", ["-create", `${window}-arm64`, `${window}-x86_64`, "-output", window]);
await exec("lipo", ["-create", `${credentials}-arm64`, `${credentials}-x86_64`, "-output", credentials]);
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
process.stdout.write(`Universal arm64/x86_64 carrier and credential helper built at ${output}\n`);
