/**
 * `keystone proof` output.
 */

import type { Catalog } from "../../types.ts";

export const proof: Catalog = {
  "Show or export the machine-readable result proof": "显示或导出机器可读的结果证明",
  Proof: "证明",
  packageId: "包 ID",
  taskId: "任务 ID",
  outcome: "结论",
  goal: "目标",
  "changed files": "变更文件",
  "within scope": "范围内",
  "Completion conditions": "完成条件",
  "(no conditions were evaluated)": "（未评估任何条件）",
  "[{status}] {id} ({kind}, min {min}{achieved}) — {reason}":
    "[{status}] {id}（{kind}，最低 {min}{achieved}）— {reason}",
  required: "必需",
  auxiliary: "辅助",
  "achieved {level}": "已达到 {level}",
  "Evidence index": "证据索引",
  none: "无",
  "evidenceId: {id}": "证据 ID：{id}",
  "Not verified and residual risk": "未验证项与残余风险",
  "none reported": "无上报项",
  "unverified: {item}": "未验证：{item}",
  "residual risk: {item}": "残余风险：{item}",
  Reproduce: "复现",
  "proof graph hash: {hash}": "证明图哈希：{hash}",
  "The task's workspace root is unknown; the proof is exported with an empty change set.":
    "任务的工作区根目录未知；导出证明时将使用空的变更集。",
  "git status could not be read; the proof is exported with an empty change set.":
    "无法读取 git status；导出证明时将使用空的变更集。",
  "No changes detected in the workspace.": "工作区未检测到变更。",
  "Wrote the proof for task {taskId} to {outFile} ({size} bytes, redaction={redaction}).":
    "已将任务 {taskId} 的证明写入 {outFile}（{size} 字节，redaction={redaction}）。",
};
