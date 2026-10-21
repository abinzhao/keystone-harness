import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeHandle, FileCredentialStore } from "./credentials.ts";
import type { CredentialResolver } from "./types.ts";

export interface CredentialBroker extends CredentialResolver {
  set(handle: string, secret: string): Promise<void>;
  delete(handle: string): Promise<void>;
  listHandles(): Promise<readonly { handle: string; present: boolean }[]>;
}

export interface CredentialHelperRequest {
  readonly operation: "set" | "resolve" | "delete" | "list";
  readonly service: string;
  readonly handle?: string;
  readonly secret?: string;
}

export interface CredentialHelperResult {
  readonly ok: boolean;
  readonly secret?: string;
  readonly handles?: readonly { handle: string; present: boolean }[];
}

export type CredentialHelperInvoker = (request: CredentialHelperRequest) => Promise<CredentialHelperResult>;

export function credentialHelperPath(): string {
  return fileURLToPath(new URL("../bin/keystone-credentials", import.meta.url));
}

export async function invokeCredentialHelper(
  input: CredentialHelperRequest,
  options: { readonly helperPath?: string; readonly args?: readonly string[] } = {},
): Promise<CredentialHelperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.helperPath ?? credentialHelperPath(), [...(options.args ?? [])], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let failed = false;
    const fail = (): void => {
      failed = true;
      reject(new Error("credential helper failed; check native availability and Keychain access"));
      child.kill();
    };
    const timer = setTimeout(fail, 30_000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 1_048_576) fail();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) return fail();
      try {
        const result = JSON.parse(output) as CredentialHelperResult;
        if (result.ok !== true) return fail();
        resolve(result);
      } catch { fail(); }
    });
    // The secret is only ever on the pipe. Errors/stderr are never propagated.
    child.stdin.end(JSON.stringify(input));
  });
}

export class KeychainCredentialBroker implements CredentialBroker {
  private readonly service: string;
  private readonly invoke: CredentialHelperInvoker;

  constructor(options: {
    readonly service: string;
    readonly helperPath?: string;
    readonly invoke?: CredentialHelperInvoker;
  }) {
    this.service = options.service;
    this.invoke = options.invoke ?? ((input) => invokeCredentialHelper(input, { helperPath: options.helperPath }));
  }

  private async call(operation: CredentialHelperRequest["operation"], handle?: string, secret?: string): Promise<CredentialHelperResult> {
    if (handle !== undefined) assertSafeHandle(handle);
    try {
      const result = await this.invoke({ operation, service: this.service,
        ...(handle === undefined ? {} : { handle }), ...(secret === undefined ? {} : { secret }) });
      if (result.ok !== true) throw new Error();
      return result;
    } catch { throw new Error("credential broker operation failed; check Keychain access"); }
  }

  async set(handle: string, secret: string): Promise<void> {
    await this.call("set", handle, secret);
  }

  async resolve(handle: string): Promise<string | undefined> {
    const result = await this.call("resolve", handle);
    if (result.secret !== undefined && typeof result.secret !== "string") throw new Error("invalid credential broker response");
    return result.secret;
  }

  async delete(handle: string): Promise<void> {
    await this.call("delete", handle);
  }

  async listHandles(): Promise<readonly { handle: string; present: boolean }[]> {
    const result = await this.call("list");
    if (!Array.isArray(result.handles)) throw new Error("invalid credential broker response");
    return result.handles.map((entry) => {
      assertSafeHandle(entry.handle);
      if (typeof entry.present !== "boolean") throw new Error("invalid credential broker response");
      return { handle: entry.handle, present: entry.present };
    });
  }
}

export interface CredentialBrokerOptions {
  readonly credentialsDir: string;
  /** Persist this identity across data-root migration; it is not secret material. */
  readonly service?: string;
  readonly identityFile?: string;
  readonly native?: boolean;
  readonly helperPath?: string;
  readonly invoke?: CredentialHelperInvoker;
}

export function createCredentialBroker(options: CredentialBrokerOptions): CredentialBroker {
  if (!(options.native ?? process.platform === "darwin")) {
    return new FileCredentialStore(options);
  }
  return new KeychainCredentialBroker({
    service: durableCredentialService(options),
    helperPath: options.helperPath, invoke: options.invoke,
  });
}

export function credentialServiceName(credentialsDir: string): string {
  const namespace = createHash("sha256").update(credentialsDir).digest("hex").slice(0, 32);
  return `net.keystone.credentials.${namespace}`;
}

export function credentialIdentityPath(credentialsDir: string): string {
  return join(dirname(credentialsDir), "credential-service.json");
}

function durableCredentialService(options: {
  readonly credentialsDir: string; readonly service?: string; readonly identityFile?: string;
}): string {
  const identityFile = options.identityFile ?? credentialIdentityPath(options.credentialsDir);
  const validate = (value: unknown): string => {
    if (typeof value !== "string" || !/^net\.keystone\.credentials\.[a-f0-9]{32}$/.test(value)) throw new Error();
    if (options.service !== undefined && options.service !== value) throw new Error();
    return value;
  };
  const read = (): string | undefined => {
    let text: string;
    try { text = readFileSync(identityFile, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const input: unknown = JSON.parse(text);
    if (typeof input !== "object" || input === null ||
        (input as Record<string, unknown>)["version"] !== "1.0.0" ||
        Object.keys(input).some((key) => key !== "version" && key !== "service")) throw new Error();
    return validate((input as Record<string, unknown>)["service"]);
  };
  try {
    const existing = read();
    if (existing !== undefined) return existing;
    const service = validate(options.service ?? credentialServiceName(options.credentialsDir));
    mkdirSync(dirname(identityFile), { recursive: true, mode: 0o700 });
    const temporary = `${identityFile}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify({ version: "1.0.0", service })}\n`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      // Publish complete bytes without overwriting another process's identity.
      try { linkSync(temporary, identityFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { unlinkSync(temporary); }
    return read()!;
  } catch { throw new Error("credential service identity is invalid or unavailable; preserve metadata before migration"); }
}

export async function migrateLegacyCredential(
  source: CredentialBroker,
  target: CredentialBroker,
  handle: string,
  options: { readonly confirmed?: boolean; readonly removeSource?: boolean },
): Promise<void> {
  if (options.confirmed !== true) throw new Error("legacy credential migration requires explicit confirmation");
  assertSafeHandle(handle);
  if (source === target) throw new Error("legacy credential migration requires distinct source and target stores");
  try {
    const secret = await source.resolve(handle);
    if (secret === undefined) throw new Error();
    const existing = await target.resolve(handle);
    if (existing !== undefined && existing !== secret) throw new Error();
    await target.set(handle, secret);
    if (await target.resolve(handle) !== secret) throw new Error();
    if (options.removeSource === true) await source.delete(handle);
  } catch { throw new Error("legacy credential migration verification failed; source is preserved unless removal completed"); }
}
