import { readFile, writeFile } from "node:fs/promises";
import { createScriptedAdapter, scriptedModelDescriptor } from "@keystone/models";
import { resolveKeystonePaths } from "@keystone/kernel";
import { KeystoneRuntime } from "../../src/keystone-runtime.ts";
import { autonomyFor, envelopeFor, FIXED_SESSION, FINISH_ACTION, writeAction } from "../fixture.ts";

const [root, home, marker] = process.argv.slice(2);
if (!root || !home || !marker) throw new Error("fixture root/home/marker required");
const runtime = await KeystoneRuntime.create({ paths: resolveKeystonePaths(home),
  models: [createScriptedAdapter({ descriptor: scriptedModelDescriptor({ id: "builder" }),
    respond: (_request, call) => {
      if (call === 0) return envelopeFor([writeAction("src/auth/session.js", FIXED_SESSION)]);
      // The previous action and checkpoint are durable by the next model call.
      if (process.send) process.send({ ready: true });
      return envelopeFor([FINISH_ACTION]);
    } })] });
await runtime.runTask({ workspacePath: root, request: "fix src/auth/session.js",
  references: [{ kind: "file", value: "src/auth/session.js" }], autonomy: autonomyFor(["src/auth/**"]),
  acceptContractAutomatically: true, onTaskCreated: (taskId) => writeFile(marker, taskId),
  control: async () => {
    // Waiting at the next control boundary preserves a genuinely live runtime
    // while the parent kills it. No graceful pause or cleanup occurs.
    if ((await readFile(`${root}/src/auth/session.js`, "utf8")) === FIXED_SESSION) {
      process.send?.({ ready: true });
      await new Promise<void>(() => {});
    }
    return undefined;
  },
});
