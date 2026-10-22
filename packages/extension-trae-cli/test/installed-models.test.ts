import assert from "node:assert/strict";
import test from "node:test";
import { decodeModels } from "../src/codec.ts";

test("real TRAE catalog names are accepted without exposing private quota or backend routing", () => {
  const rows = decodeModels([{
    name: "Seed-2.1-Turbo", config_name: "Doubao-Seed-2.1-Turbo", backend_model: "private",
    provider: "trae", _meta: { account: "private", quota: 99 },
  }]);
  assert.deepEqual(rows, [{ modelName: "Seed-2.1-Turbo", displayName: "Seed-2.1-Turbo" }]);
});
