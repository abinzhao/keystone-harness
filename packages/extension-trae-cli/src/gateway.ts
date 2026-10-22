import { createServer, connect, isIPv4, isIP, type AddressInfo, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { TraeCliError } from "./errors.ts";

export class GatewayPortInUseError extends TraeCliError {
  constructor() { super("confinement"); this.name = "GatewayPortInUseError"; }
}
export interface GatewayOptions {
  port: number;
  hosts: readonly string[];
  authToken: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onFailure?: () => void;
  allowPrivateNetwork?: boolean;
}
export interface Gateway {
  address: AddressInfo;
  close(): Promise<void>;
  assertSafe(): void;
}
export function safeHost(value: unknown): value is string {
  return typeof value === "string" && value.length <= 253 && value === value.toLowerCase() && !isIP(value) &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value) &&
    value.split(".").every((label) => label.length <= 63) &&
    !/(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(value);
}
export function publicAddress(value: string): boolean {
  if (!isIPv4(value)) return false;
  const [a = 0, b = 0, c = 0] = value.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
export function allowedAddress(value: string, allowPrivateNetwork = false): boolean {
  if (publicAddress(value)) return true;
  if (!allowPrivateNetwork || !isIPv4(value)) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}
export function tlsServerName(bytes: Buffer): string | undefined {
  const payloads: Buffer[] = [];
  let offset = 0;
  let payloadSize = 0;
  while (offset < bytes.length) {
    if (bytes[offset] !== 22) throw new TraeCliError("isolation_violation");
    if (bytes.length - offset < 5) return undefined;
    if (bytes[offset + 1] !== 3) throw new TraeCliError("isolation_violation");
    const size = bytes.readUInt16BE(offset + 3);
    if (size === 0 || size > 16384) throw new TraeCliError("isolation_violation");
    if (offset + size + 5 > 16384) throw new TraeCliError("output_limit");
    if (bytes.length - offset < size + 5) return undefined;
    payloads.push(bytes.subarray(offset + 5, offset + 5 + size));
    payloadSize += size;
    offset += size + 5;
    if (payloadSize < 4) continue;
    const payload = Buffer.concat(payloads);
    if (payload[0] !== 1) throw new TraeCliError("isolation_violation");
    const length = payload.readUIntBE(1, 3);
    if (length > 16380) throw new TraeCliError("output_limit");
    if (payload.length < length + 4) continue;
    const body = payload.subarray(4, length + 4);
    let cursor = 34;
    const need = (amount: number) => {
      if (cursor + amount > body.length) throw new TraeCliError("isolation_violation");
    };
    const skipVector = (width: 1 | 2) => {
      need(width);
      const count = width === 1 ? body[cursor]! : body.readUInt16BE(cursor);
      cursor += width; need(count); cursor += count;
    };
    skipVector(1); skipVector(2); skipVector(1);
    need(2);
    const extensionsLength = body.readUInt16BE(cursor); cursor += 2;
    if (cursor + extensionsLength !== body.length) throw new TraeCliError("isolation_violation");
    let name: string | undefined;
    while (cursor < body.length) {
      need(4);
      const type = body.readUInt16BE(cursor);
      const size = body.readUInt16BE(cursor + 2);
      cursor += 4; need(size);
      if (type === 0xfe0d) throw new TraeCliError("isolation_violation"); // ECH hides the destination.
      if (type === 0) {
        if (name || size < 5 || body.readUInt16BE(cursor) !== size - 2 || body[cursor + 2] !== 0 ||
            body.readUInt16BE(cursor + 3) !== size - 5) throw new TraeCliError("isolation_violation");
        name = body.subarray(cursor + 5, cursor + size).toString("ascii");
        if (!safeHost(name)) throw new TraeCliError("isolation_violation");
      }
      cursor += size;
    }
    if (!name) throw new TraeCliError("isolation_violation");
    return name;
  }
  return undefined;
}

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  if (!options.hosts.length || options.hosts.some((host) => !safeHost(host))) throw new TraeCliError("configuration");
  if (options.signal?.aborted) throw new TraeCliError("cancelled");
  const sockets = new Set<Socket>();
  let failure: TraeCliError | undefined;
  let closed = false;
  let connections = 0;
  let bytes = 0;
  const destroy = () => { for (const socket of sockets) socket.destroy(); };
  const fail = (error: TraeCliError) => {
    destroy();
    if (failure || closed) return;
    failure = error; options.onFailure?.();
  };
  const count = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > options.maxBytes) throw new TraeCliError("output_limit");
  };
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A caller can cancel an admitted HTTPS request, or a peer can reset it.
    // Close that stream; policy violations and absolute budgets still fail the
    // whole transport, and CLI output must independently establish success.
    socket.on("error", () => socket.destroy());
    socket.setTimeout(Math.min(options.timeoutMs, 5000), () => fail(new TraeCliError("timeout")));
  };
  const server = createServer((socket) => {
    track(socket);
    if (closed || failure || ++connections > 16) return fail(new TraeCliError("isolation_violation"));
    let pending = Buffer.alloc(0);
    let host: string | undefined;
    let dialing = false;
    const receive = async (chunk: Buffer) => {
      try {
        count(chunk);
        if (dialing) throw new TraeCliError("isolation_violation");
        pending = Buffer.concat([pending, chunk]);
        if (!host) {
          const end = pending.indexOf("\r\n\r\n");
          if ((end < 0 && pending.length > 4096) || end + 4 > 4096) throw new TraeCliError("output_limit");
          if (end < 0) return;
          const header = pending.subarray(0, end).toString("latin1");
          const lines = header.split("\r\n");
          const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.1$/.exec(lines.shift() ?? "");
          const expected = "Basic " + Buffer.from("keystone:" + options.authToken).toString("base64");
          const auth = lines.filter((line) => /^proxy-authorization:/i.test(line));
          if (!match || !options.hosts.includes(match[1]!) || auth.length !== 1 ||
              auth[0]!.slice(auth[0]!.indexOf(":") + 1).trim() !== expected) {
            throw new TraeCliError("isolation_violation");
          }
          host = match[1]!;
          pending = pending.subarray(end + 4);
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        }
        const sni = tlsServerName(pending);
        if (sni === undefined) return;
        if (sni !== host) throw new TraeCliError("isolation_violation");
        dialing = true;
        socket.pause();
        const addresses = await lookup(host, { all: true, family: 4 });
        if (closed || failure || socket.destroyed) return;
        if (!addresses.length || addresses.some((entry) => !allowedAddress(entry.address, options.allowPrivateNetwork))) {
          throw new TraeCliError("isolation_violation");
        }
        const remote = connect({ host: addresses[0]!.address, port: 443 });
        track(remote);
        socket.once("close", () => remote.destroy());
        remote.once("close", () => socket.destroy());
        remote.once("connect", () => {
          if (closed || failure || socket.destroyed) { remote.destroy(); return; }
          // TLS setup is short; inference can be quiet for much longer. The
          // absolute gateway lifetime still bounds both admitted sockets.
          socket.setTimeout(options.timeoutMs);
          remote.setTimeout(options.timeoutMs);
          socket.removeListener("data", receive);
          remote.write(pending);
          socket.on("data", (data: Buffer) => {
            try { count(data); } catch { fail(new TraeCliError("output_limit")); }
          });
          remote.on("data", (data: Buffer) => {
            try { count(data); } catch { fail(new TraeCliError("output_limit")); }
          });
          socket.pipe(remote); remote.pipe(socket); socket.resume();
        });
      } catch (error) { fail(error instanceof TraeCliError ? error : new TraeCliError("confinement")); }
    };
    socket.on("data", receive);
  });
  const abort = () => fail(new TraeCliError("cancelled"));
  const lifetime = setTimeout(() => fail(new TraeCliError("timeout")), options.timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => reject(
        error.code === "EADDRINUSE" ? new GatewayPortInUseError() : new TraeCliError("confinement")));
      server.listen({ host: "127.0.0.1", port: options.port, exclusive: true }, resolve);
    });
  } catch (error) {
    clearTimeout(lifetime); options.signal?.removeEventListener("abort", abort); destroy();
    throw error;
  }
  if (options.signal?.aborted) abort();
  return {
    address: server.address() as AddressInfo,
    assertSafe() { if (failure) throw failure; },
    async close() {
      if (closed) return;
      closed = true; clearTimeout(lifetime);
      options.signal?.removeEventListener("abort", abort);
      destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
