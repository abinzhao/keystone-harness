/**
 * `keystone project` output.
 */

import type { Catalog } from "../../types.ts";

export const project: Catalog = {
  "Attach and inspect a project's profile and support matrix": "接入并查看项目的配置与支持矩阵",
  "Keystone requires a Git work tree for recovery, branching and evidence invalidation.":
    "Keystone 需要 Git 工作树来进行恢复、分支和证据失效。",

  // `project inspect` sections and key/value labels.
  Project: "项目",
  name: "名称",
  root: "根目录",
  vcs: "版本控制",
  languages: "语言",
  "package manager": "包管理器",
  "Support matrix": "支持矩阵",
  status: "状态",
  reason: "原因",
  Commands: "命令",
  "Instruction files": "指令文件",
  "Workspace snapshot": "工作区快照",

  // Fallbacks shown when nothing was detected.
  "(none detected)": "（未检测到）",
  "(none)": "（无）",
  "unknown source": "未知来源",
  "none found (no AGENTS.md, CLAUDE.md or .cursor/rules)": "未找到（没有 AGENTS.md、CLAUDE.md 或 .cursor/rules）",
  "(no commits)": "（无提交）",
  "(unknown)": "（未知）",

  // Per-command detection lines.
  "[identified]   {kind}: {command}  ({source})": "[已识别]   {kind}：{command}  （{source}）",
  "[unrecognized] {kind}: not identified in this project — Keystone will not guess a command":
    "[未识别] {kind}：未在本项目中识别到——Keystone 不会猜测命令",

  // Workspace snapshot rows.
  "tracked files": "跟踪的文件",
  dirty: "未提交改动",
  "yes (uncommitted changes present)": "是（存在未提交的改动）",
  "entries truncated": "条目已截断",
  yes: "是",
  no: "否",
  head: "HEAD",
  branch: "分支",

  "fingerprint: {value}": "指纹：{value}",
};
