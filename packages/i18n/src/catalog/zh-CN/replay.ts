/**
 * `keystone replay` output.
 */

import type { Catalog } from "../../types.ts";

export const replay: Catalog = {
  "Replay a task's state from its ledger and check consistency": "从账本重放任务状态并检查一致性",
  Replay: "重放",
  taskId: "任务 ID",
  status: "状态",
  seq: "序号",
  consistent: "一致",
  "State cannot be replayed consistently: the ledger no longer folds to the status that was recorded.":
    "无法一致地重放状态：账本不再折叠为已记录的状态。",
};
