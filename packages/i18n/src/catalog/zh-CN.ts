/**
 * Simplified Chinese catalog.
 *
 * Split by surface (`common`, one file per CLI command, `workbench`) so a change
 * to one command's wording touches one file. Every key is an English source
 * string that appears in the code; a key that lives here but appears nowhere in
 * the code is dead weight and should be removed.
 */

import type { Catalog } from "../types.ts";
import { common } from "./zh-CN/common.ts";
import { doctor } from "./zh-CN/doctor.ts";
import { help } from "./zh-CN/help.ts";
import { model } from "./zh-CN/model.ts";
import { project } from "./zh-CN/project.ts";
import { proof } from "./zh-CN/proof.ts";
import { protocol } from "./zh-CN/protocol.ts";
import { replay } from "./zh-CN/replay.ts";
import { serve } from "./zh-CN/serve.ts";
import { task } from "./zh-CN/task.ts";
import { workbench } from "./zh-CN/workbench.ts";

export const zhCN: Catalog = {
  ...common,
  ...help,
  ...task,
  ...proof,
  ...replay,
  ...protocol,
  ...model,
  ...doctor,
  ...project,
  ...serve,
  ...workbench,
};
