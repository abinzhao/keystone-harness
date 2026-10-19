/**
 * Top-level help and the errors the CLI entry point itself emits. Per-command
 * summaries and `--help` bodies live with their command, in that command's own
 * catalog file.
 */

import type { Catalog } from "../../types.ts";

export const help: Catalog = {
  "keystone — evidence-native, local-first engineering agent harness":
    "keystone —— 证据原生、本地优先的工程 Agent Harness",
  "Usage: keystone <command> [options]": "用法：keystone <command> [options]",
  "Commands:": "命令：",
  "Options:": "选项：",
  "Output language (default: zh-CN)": "输出语言（默认：zh-CN）",
  "Run `keystone <command> --help` for command-specific options.":
    "运行 `keystone <command> --help` 查看各命令的详细选项。",
  'Run "keystone --help" for usage.': '运行 "keystone --help" 查看用法。',
  'unknown command "{command}"': '未知命令 "{command}"',
};
