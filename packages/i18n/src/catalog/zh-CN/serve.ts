/**
 * `keystone serve` output.
 */

import type { Catalog } from "../../types.ts";

export const serve: Catalog = {
  "Serve the runtime to a local shell over the Keystone Run Protocol":
    "通过 Keystone Run Protocol 向本地 shell 提供运行时服务",

  // Startup diagnostics.
  "Using the built-in scripted model: deterministic, offline execution (tests / evaluation, PRD EX-05).":
    "使用内置的 scripted 模型：确定性的离线执行（测试/评估，PRD EX-05）。",
  'skipping model "{id}": {message}': '跳过模型 "{id}"：{message}',
  "No usable model is configured, so tasks started from the workbench will fail at their first":
    "未配置可用的模型，因此从工作台启动的任务将在第一次",
  "model call. Configure one with `keystone model add ...` and `keystone model credential set <handle>`.":
    "模型调用时失败。请使用 `keystone model add ...` 和 `keystone model credential set <handle>` 配置模型。",

  // Startup banner and workbench details.
  "Keystone Run Protocol server": "Keystone Run Protocol 服务器",
  protocol: "协议",
  listening: "监听地址",
  mode: "模式",
  models: "模型",
  "(none configured)": "（未配置）",
  Workbench: "工作台",
  "Bearer token: {token}": "Bearer 令牌：{token}",
  "Press Ctrl+C to stop.": "按 Ctrl+C 停止。",
  "Server stopped.": "服务器已停止。",
};
