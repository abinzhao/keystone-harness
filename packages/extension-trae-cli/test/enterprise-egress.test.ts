import assert from "node:assert/strict";
import test from "node:test";
import * as gateway from "../src/gateway.ts";

test("enterprise network opt-in permits only private routed IPv4 and never local or metadata addresses", () => {
  const fn = (gateway as any).allowedAddress;
  assert.equal(typeof fn, "function");
  assert.equal(fn("10.8.6.227", false), false);
  assert.equal(fn("10.8.6.227", true), true);
  assert.equal(fn("172.16.5.10", true), true);
  for (const address of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "224.1.1.1", "::1"]) {
    assert.equal(fn(address, true), false, address);
  }
});
