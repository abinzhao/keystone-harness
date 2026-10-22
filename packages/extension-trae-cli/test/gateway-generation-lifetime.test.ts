import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { connect } from "node:net";
import { startGateway } from "../src/gateway.ts";
import { hello } from "./fixtures.ts";

test("authenticated TLS tunnel preserves the inference lifetime after bounded handshake", async context => {
  const require = createRequire(import.meta.url);
  const net = require("node:net"), dns = require("node:dns/promises");
  const originalConnect = connect;
  let remoteTimeout = 0;
  let connected!: () => void;
  const ready = new Promise<void>(resolve => { connected = resolve; });
  const remote = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(); connected(); },
  });
  (remote as any).setTimeout = (value: number) => { remoteTimeout = value; return remote; };
  context.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  context.mock.method(net, "connect", () => { queueMicrotask(() => remote.emit("connect")); return remote; });
  syncBuiltinESMExports();
  const gateway = await startGateway({
    port: 0, hosts: ["api.example.com"], authToken: "synthetic", maxBytes: 65536, timeoutMs: 12000,
  });
  const client = originalConnect(gateway.address.port, "127.0.0.1");
  try {
    await once(client, "connect");
    const response = once(client, "data");
    client.write("CONNECT api.example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic " +
      Buffer.from("keystone:synthetic").toString("base64") + "\r\n\r\n");
    await response;
    client.write(hello("api.example.com"));
    await ready;
    assert.equal(remoteTimeout, 12000, "an admitted model response may remain idle longer than the handshake limit");
    gateway.assertSafe();
  } finally {
    client.destroy(); await gateway.close();
    context.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("an admitted peer reset closes its tunnel without invalidating other model traffic", async context => {
  const require = createRequire(import.meta.url);
  const net = require("node:net"), dns = require("node:dns/promises"), originalConnect = connect;
  let admitted!: () => void;
  const ready = new Promise<void>(resolve => { admitted = resolve; });
  const remote = new Duplex({ read() {}, write(_data, _encoding, callback) { callback(); admitted(); } });
  (remote as any).setTimeout = () => remote;
  context.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  context.mock.method(net, "connect", () => { queueMicrotask(() => remote.emit("connect")); return remote; });
  syncBuiltinESMExports();
  let failed = false;
  const gateway = await startGateway({
    port: 0, hosts: ["api.example.com"], authToken: "synthetic", maxBytes: 65536, timeoutMs: 12000,
    onFailure: () => { failed = true; },
  });
  const client = originalConnect(gateway.address.port, "127.0.0.1");
  try {
    await once(client, "connect");
    const response = once(client, "data");
    client.write("CONNECT api.example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic " +
      Buffer.from("keystone:synthetic").toString("base64") + "\r\n\r\n");
    await response;
    client.write(hello("api.example.com"));
    await ready;
    const closed = once(client, "close");
    remote.emit("error", Object.assign(new Error("synthetic peer reset"), { code: "ECONNRESET" }));
    await closed;
    assert.doesNotThrow(() => gateway.assertSafe());
    assert.equal(failed, false);
    assert.equal(remote.destroyed, true);
  } finally {
    client.destroy(); await gateway.close();
    context.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("coalesced CONNECT, TLS hello and application data retain header and hello bounds", async context => {
  const require = createRequire(import.meta.url);
  const net = require("node:net"), dns = require("node:dns/promises"), originalConnect = connect;
  const tunnel = Buffer.concat([hello("api.example.com"), Buffer.alloc(45000, 23)]);
  let resolve!: () => void, reject!: (error: Error) => void;
  const forwarded = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const received: Buffer[] = [];
  const remote = new Duplex({ read() {}, write(data, _encoding, callback) {
    received.push(Buffer.from(data)); callback(); resolve();
  } });
  (remote as any).setTimeout = () => remote;
  context.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  context.mock.method(net, "connect", () => { queueMicrotask(() => remote.emit("connect")); return remote; });
  syncBuiltinESMExports();
  const gateway = await startGateway({
    port: 0, hosts: ["api.example.com"], authToken: "synthetic", maxBytes: 65536, timeoutMs: 2000,
    onFailure: () => reject(new Error("coalesced request refused")),
  });
  const client = originalConnect(gateway.address.port, "127.0.0.1");
  try {
    await once(client, "connect");
    client.write(Buffer.concat([Buffer.from("CONNECT api.example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic " +
      Buffer.from("keystone:synthetic").toString("base64") + "\r\n\r\n"), tunnel]));
    await forwarded;
    assert.deepEqual(Buffer.concat(received), tunnel);
    gateway.assertSafe();
  } finally {
    client.destroy(); await gateway.close();
    context.mock.restoreAll(); syncBuiltinESMExports();
  }
});
