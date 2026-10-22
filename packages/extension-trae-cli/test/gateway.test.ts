import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { safeHost, publicAddress, tlsServerName, startGateway } from "../src/gateway.ts";
import { hello } from "./fixtures.ts";

function u16(value: number) { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; }

test("destinations require exact public DNS names and public IPv4 resolutions", () => {
  assert.ok(safeHost("api.example.com"));
  for (const host of ["localhost", "foo.localhost", "*.example.com", "127.0.0.1", "10.0.0.1",
    "example.com:443", "example.com/path", "-x.example.com", "foo.local", "foo.internal", "foo.test"]) {
    assert.equal(safeHost(host), false, host);
  }
  assert.ok(publicAddress("93.184.216.34"));
  for (const address of ["127.0.0.1", "10.0.0.1", "0.0.0.0", "172.16.0.1", "192.168.1.1",
    "169.254.169.254", "100.64.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.1.1.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(publicAddress(address), false, address);
  }
});

test("TLS ClientHello SNI is parsed across truncated and fragmented records", () => {
  const bytes = hello("api.example.com");
  for (let length = 0; length < bytes.length; length++) assert.equal(tlsServerName(bytes.subarray(0, length)), undefined);
  assert.equal(tlsServerName(bytes), "api.example.com");
  const payload = bytes.subarray(5);
  const fragmented = Buffer.concat([Buffer.from([22, 3, 1]), u16(10), payload.subarray(0, 10),
    Buffer.from([22, 3, 1]), u16(payload.length - 10), payload.subarray(10)]);
  assert.equal(tlsServerName(fragmented), "api.example.com");
  assert.equal(tlsServerName(Buffer.concat([bytes, Buffer.alloc(45000, 23)])), "api.example.com",
    "coalesced application records do not enlarge the ClientHello parsing budget");
  assert.throws(() => tlsServerName(Buffer.from("GET / HTTP/1.1\r\n")), { code: "isolation_violation" });
  assert.throws(() => tlsServerName(hello("127.0.0.1")), { code: "isolation_violation" });
  assert.throws(() => tlsServerName(Buffer.alloc(20000)), { code: "isolation_violation" });
  const oversized = Buffer.alloc(16389);
  oversized[0] = 22; oversized[1] = 3; oversized.writeUInt16BE(16384, 3);
  assert.throws(() => tlsServerName(oversized), { code: "output_limit" });
});

async function rejected(request: string, suffix?: Buffer) {
  const gateway = await startGateway({ port: 0, hosts: ["api.example.com"], authToken: "synthetic",
    maxBytes: 16384, timeoutMs: 1000 });
  const socket = connect(gateway.address.port, "127.0.0.1");
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(request);
    if (suffix) {
      await once(socket, "data");
      socket.write(suffix);
    }
    await closed;
    assert.throws(() => gateway.assertSafe(), { code: "isolation_violation" });
  } finally { socket.destroy(); await gateway.close(); }
}
const auth = "Proxy-Authorization: Basic " + Buffer.from("keystone:synthetic").toString("base64");

test("real proxy sockets reject plaintext, missing auth, foreign hosts and alternate ports", async () => {
  for (const request of [
    "GET https://api.example.com/ HTTP/1.1\r\n\r\n",
    "CONNECT api.example.com:443 HTTP/1.1\r\n\r\n",
    `CONNECT secret.example.com:443 HTTP/1.1\r\n${auth}\r\n\r\n`,
    `CONNECT api.example.com:80 HTTP/1.1\r\n${auth}\r\n\r\n`,
  ]) await rejected(request);
});

test("CONNECT cannot tunnel a different SNI, plaintext, or oversize TLS hello", async () => {
  const request = `CONNECT api.example.com:443 HTTP/1.1\r\n${auth}\r\n\r\n`;
  for (const suffix of [hello("other.example.com"), Buffer.from("GET / HTTP/1.1\r\n\r\n")]) {
    await rejected(request, suffix);
  }
});

test("idle and cancelled sockets close within the bounded lifetime", async () => {
  const controller = new AbortController();
  const gateway = await startGateway({ port: 0, hosts: ["api.example.com"], authToken: "synthetic",
    maxBytes: 16384, timeoutMs: 200, signal: controller.signal });
  const socket = connect(gateway.address.port, "127.0.0.1");
  await once(socket, "connect");
  const closed = once(socket, "close");
  controller.abort();
  await closed;
  await gateway.close();
  await delay(5);
  assert.throws(() => gateway.assertSafe(), { code: "cancelled" });
});

test("gateway violations notify the process boundary immediately", async () => {
  let notified = false;
  const gateway = await startGateway({ port: 0, hosts: ["api.example.com"], authToken: "synthetic",
    maxBytes: 16384, timeoutMs: 1000, onFailure: () => { notified = true; } });
  const socket = connect(gateway.address.port, "127.0.0.1");
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write("GET / HTTP/1.1\r\n\r\n");
    await closed;
    assert.equal(notified, true);
  } finally { socket.destroy(); await gateway.close(); }
});
