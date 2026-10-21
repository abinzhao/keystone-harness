import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "../../schemas/src/index.ts";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2);
if (process.platform !== "darwin") throw new Error("local app packaging requires macOS");
if (args.length !== 2 || args[0] !== "--out") throw new Error("usage: package-local.ts --out NEW_DIRECTORY");
const output = resolve(args[1]!);
await mkdir(output); // Never overwrite an existing application or output tree.
const app = join(output, "Keystone.app");
const contents = join(app, "Contents");
const resources = join(contents, "Resources");
const source = join(resources, "app");
const binaries = join(contents, "MacOS");
await mkdir(source, { recursive: true });
await mkdir(binaries, { recursive: true });

const files: { path: string; sha256: string; bytes: number }[] = [];
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("source resource symlinks are not packaged implicitly");
    if (entry.isDirectory()) await copyTree(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) await copyFile(join(from, entry.name), join(to, entry.name));
  }
}
const packageNames = (await readdir(join(repository, "packages"))).sort();
const links = join(source, "node_modules", "@keystone");
await mkdir(links, { recursive: true });
for (const name of packageNames) {
  const original = join(repository, "packages", name);
  if (!(await lstat(original)).isDirectory()) continue;
  const target = join(source, "packages", name);
  await mkdir(target, { recursive: true });
  await copyFile(join(original, "package.json"), join(target, "package.json"));
  await copyTree(join(original, "src"), join(target, "src"));
  if (name === "runtime") await copyTree(join(original, "web"), join(target, "web"));
  await symlink(`../../packages/${name}`, join(links, name));
}
const metadata = JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as { version: string };
await writeFile(join(source, "package.json"), JSON.stringify({
  name: "keystone-local-app", version: metadata.version, private: true, type: "module",
  engines: { node: ">=22.18.0" },
}, null, 2));
await mkdir(join(source, "scripts", "release"), { recursive: true });
await copyFile(join(repository, "scripts", "release", "readiness.ts"), join(source, "scripts", "release", "readiness.ts"));
await copyFile(join(repository, "LICENSE"), join(resources, "LICENSE"));

// The native carrier is universal; the embedded Node binary has the verified
// architecture of this build host. Other hosts require their own local bundle.
const native = join(output, "native");
await exec(process.execPath, [join(repository, "packages", "desktop", "scripts", "build-native.ts"), "--out", native],
  { timeout: 120_000, maxBuffer: 1024 * 1024 });
for (const [name, packageName] of [["keystone-window", "desktop"], ["keystone-credentials", "models"]] as const) {
  const target = join(source, "packages", packageName, "bin", name);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(native, name), target);
  await chmod(target, 0o755);
}
const node = join(resources, "node");
const libraries = (await exec("otool", ["-L", process.execPath])).stdout.split("\n").slice(1)
  .map((line) => line.trim().split(" (")[0]!).filter(Boolean);
if (libraries.some((library) => !library.startsWith("/usr/lib/") && !library.startsWith("/System/Library/"))) {
  throw new Error("Node has non-system dynamic dependencies; self-contained packaging is unavailable");
}
await copyFile(process.execPath, node);
await chmod(node, 0o755);
await writeFile(join(resources, "self-check.mjs"), [
  'import { mkdtemp, rm } from "node:fs/promises";',
  'import { tmpdir } from "node:os";',
  'import { join } from "node:path";',
  'import { resolveKeystonePaths } from "./app/packages/kernel/src/index.ts";',
  'import { startServer } from "./app/packages/runtime/src/index.ts";',
  'const home = await mkdtemp(join(tmpdir(), "keystone-packaged-check-"));',
  'let server;',
  'try {',
  '  server = await startServer({ paths: resolveKeystonePaths(home), models: [] });',
  '  const response = await fetch(`http://127.0.0.1:${server.port}/v1/capabilities`, {headers:{authorization:`Bearer ${server.token}`}});',
  '  if (!response.ok) throw new Error("packaged runtime capability check failed");',
  '  const result = await response.json();',
  '  console.log(JSON.stringify({selfContained:true,nodeVersion:process.version,architecture:process.arch,protocolVersion:result.protocolVersion,checks:3,failures:0}));',
  '} finally { await server?.close(); await rm(home,{recursive:true,force:true}); }',
].join("\n"));
const launcher = join(binaries, "keystone-start");
await writeFile(launcher, [
  "#!/bin/sh",
  'case "$1" in',
  '  --self-check) exec "$(dirname "$0")/../Resources/node" "$(dirname "$0")/../Resources/self-check.mjs" ;;',
  '  *) exec "$(dirname "$0")/../Resources/node" "$(dirname "$0")/../Resources/app/packages/desktop/src/bin.ts" "$@" ;;',
  "esac",
  "",
].join("\n"));
await chmod(launcher, 0o755);
const plist = (await readFile(join(repository, "packages", "desktop", "src-native", "Info.plist"), "utf8"))
  .replace("<string>keystone-window</string>", "<string>keystone-start</string>");
await writeFile(join(contents, "Info.plist"), plist);
const check = await exec(launcher, ["--self-check"], { timeout: 30_000, maxBuffer: 1024 * 1024,
  env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" } });
const observed = JSON.parse(check.stdout.trim()) as { selfContained: boolean; checks: number; failures: number };
if (!observed.selfContained || observed.failures !== 0) throw new Error("packaged self-check did not pass");
async function inventory(root: string, prefix = ""): Promise<void> {
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) await inventory(join(root, entry.name), `${path}/`);
    else if (entry.isFile()) {
      const bytes = await readFile(join(root, entry.name));
      files.push({ path, bytes: bytes.length, sha256: sha256Bytes(bytes) });
    }
  }
}
await inventory(app);
await writeFile(join(output, "package-report.json"), JSON.stringify({
  version: "keystone.local-package/1", releaseVersion: metadata.version, selfCheck: observed,
  embeddedNodeArchitectures: [process.arch], nativeCarrierArchitectures: ["arm64", "x86_64"],
  signing: "not_verified", notarization: "not_performed", app, files,
}, null, 2) + "\n");
process.stdout.write(`Local self-contained ${process.arch} application created at ${app}\n`);
