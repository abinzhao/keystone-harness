import assert from "node:assert/strict";
import test from "node:test";
import { createTransport } from "../src/transport.ts";

test("exec does not send the interactive-only no-daemon flag", { skip: process.platform !== "darwin" }, async () => {
  const transport = await createTransport({
    cliPath: "/Users/bytedance/.local/bin/trae-cli",
    endpointHost: "copilot-cn.bytedance.net", egressHosts: ["copilot-cn.bytedance.net"], isActive: () => true,
  });
  const prepared = transport.prepare("generate", ["exec", "--json"]);
  assert.equal(prepared.proposal.parameters.args.includes("--no-daemon"), false);
});
