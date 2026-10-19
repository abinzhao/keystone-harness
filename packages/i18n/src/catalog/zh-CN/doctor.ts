/**
 * `keystone doctor` output.
 */

import type { Catalog } from "../../types.ts";

export const doctor: Catalog = {
  Environment: "环境",
  node: "node",
  "(ok)": "（正常）",
  "(requires >= {version})": "（要求 >= {version}）",
  KEYSTONE_HOME: "KEYSTONE_HOME",
  home: "主目录",
  writable: "可写",
  yes: "是",
  no: "否",
  "(not set)": "（未设置）",
  "Node {required} or newer is required; this is {actual}. Upgrade Node, then re-run.":
    "需要 Node {required} 或更高版本；当前为 {actual}。请升级 Node 后重试。",
  "The store root is not writable: {path}. Fix permissions or set KEYSTONE_HOME to a writable directory.":
    "存储根目录不可写：{path}。请修复权限，或将 KEYSTONE_HOME 设为一个可写目录。",
  Git: "Git",
  git: "git",
  "not found": "未找到",
  "git was not found on PATH. Keystone requires a Git work tree for recovery, branching and evidence.":
    "在 PATH 中未找到 git。Keystone 需要 Git 工作树来支持恢复、分支与证据。",
  Models: "模型",
  config: "配置",
  "(none — run `keystone model add ...`)": "（无 —— 请运行 `keystone model add ...`）",
  "usable models": "可用模型",
  "No model is configured. Run `keystone model add ...` then `keystone model credential set <handle>` (BYOK).":
    "未配置任何模型。请先运行 `keystone model add ...`，再运行 `keystone model credential set <handle>`（BYOK）。",
  Registry: "注册表",
  tools: "工具",
  verifiers: "验证器",
  "protocol schemas": "协议 Schema",
  "tools: {list}": "工具: {list}",
  "verifiers: {list}": "验证器: {list}",
  "Diagnose the CLI's environment and configuration": "诊断 CLI 的环境与配置",
};
