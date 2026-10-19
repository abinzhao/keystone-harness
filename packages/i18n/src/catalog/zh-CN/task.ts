/**
 * `keystone task` output.
 */

import type { Catalog } from "../../types.ts";

export const task: Catalog = {
  // Section titles.
  "A decision is required": "需要你做出决定",
  "Task": "任务",
  "Completion conditions": "完成条件",
  "Not verified and residual risk": "未验证项与残余风险",
  "Reproduce": "复现",
  "Why it stopped": "停止原因",
  "Pending decisions": "待决策项",
  "Tasks": "任务列表",
  "Contract": "契约",
  "Evidence": "证据",
  "Latest checkpoint": "最新检查点",
  "Events": "事件",
  "Recovery": "恢复",
  "Affected by the change": "受变更影响",
  "Branch": "分支",
  "Branch comparison": "分支比较",
  "Recommendation": "建议",

  // `keyValue` labels.
  "taskId": "任务 ID",
  "status": "状态",
  "mode": "模式",
  "steps": "步数",
  "files changed": "变更文件",
  "stage": "阶段",
  "branch": "分支",
  "pending decisions": "待决策",
  "evidence records": "证据记录",
  "updated": "更新时间",
  "goal": "目标",
  "version": "版本",
  "branch id": "分支 ID",
  "label": "标签",
  "parent checkpoint": "父检查点",
  "forked from": "派生自",
  "reason": "原因",
  "checkpointId": "检查点 ID",
  "at": "时间",

  // Interactive decision prompt.
  "Why you: {reason}": "为什么需要你：{reason}",
  "If ignored: {impact}": "若忽略：{impact}",
  "[{index}] {label} — {scope} (budget: {budget})": "[{index}] {label} —— {scope}（预算：{budget}）",
  "Recommended: {label} — {rationale}": "推荐：{label} —— {rationale}",
  "Choose [a]llow / [d]eny / [m]odify (default: allow the recommendation): ":
    "请选择 [a] 允许 / [d] 拒绝 / [m] 修改（默认：采纳建议）：",

  // Model setup and run.
  "Using the built-in scripted model: deterministic, offline execution (tests / evaluation, PRD EX-05).":
    "正在使用内置脚本模型：确定性、离线执行（测试 / 评估，PRD EX-05）。",
  'skipping model "{id}": {reason}': '跳过模型 "{id}"：{reason}',
  "No usable model is configured, so no task can run. Configure a model (BYOK) first:":
    "尚未配置可用的模型，无法运行任务。请先配置模型（BYOK）：",
  "For offline evaluation only, pass --scripted-fixture <file.json>.":
    "仅在离线评估时，请传入 --scripted-fixture <file.json>。",
  "Note: no --write-path was given, so the Autonomy Envelope has no writable paths.":
    "注意：未提供 --write-path，因此自治边界中没有可写路径。",
  "The task will stop for approval when it tries to change a file. Re-run with --write-path <glob>.":
    "任务尝试修改文件时将暂停以等待批准。请使用 --write-path <glob> 重新运行。",
  "Pending decision (non-interactive; the task will stop): {question}":
    "待决策（非交互模式；任务将停止）：{question}",
  "(no contract conditions were evaluated)": "（未评估任何契约条件）",
  "[{mark}] {conditionId} ({kind}, min {level}) — {verdict}: {reasonCode}":
    "[{mark}] {conditionId}（{kind}，最低 {level}）—— {verdict}：{reasonCode}",
  "ok": "通过",
  "OPEN": "未通过",
  "required": "必需",
  "auxiliary": "辅助",
  "satisfied": "已满足",
  "not satisfied": "未满足",
  ", achieved {level}": "，实际达到 {level}",
  "none reported": "无",
  "unverified: {item}": "未验证：{item}",
  "residual risk: {item}": "残余风险：{item}",

  // `task list`.
  "no tasks found": "未找到任务",
  "{status} stage={stage} pending={pending} updated={updated}  {taskId}":
    "{status} 阶段={stage} 待决策={pending} 更新时间={updated}  {taskId}",
  "[unrecoverable] {taskId}: {reason}": "[不可恢复] {taskId}：{reason}",

  // `task show`.
  "no contract has been compiled for this task yet": "该任务尚未编译契约",
  "scope include: {paths}": "范围包含：{paths}",
  "scope exclude: {paths}": "范围排除：{paths}",
  "(none)": "（无）",
  "unresolved scope: {paths}": "未解析的范围：{paths}",
  "invariant: {description}": "不变量：{description}",
  "completion conditions:": "完成条件：",
  "- {conditionId} ({kind}, min {level}{independence}): {description}":
    "- {conditionId}（{kind}，最低 {level}{independence}）：{description}",
  ", independent": "，独立",
  "none recorded": "无记录",
  "evidence ids: {ids}": "证据 ID：{ids}",
  "none": "无",
  "integrity: {value}": "完整性：{value}",

  // `task pause` / `task stop`.
  'task {taskId} is now "{status}"': '任务 {taskId} 现在为 "{status}"',

  // `task resume`.
  "resuming from checkpoint {checkpointId}": "从检查点 {checkpointId} 恢复",
  "cannot resume: the task's workspace root is unknown (project record is missing)":
    "无法恢复：任务的工作区根目录未知（项目记录缺失）",
  "changed: {path}": "已变更：{path}",
  "invalidated evidence: {ids}": "已失效的证据：{ids}",
  "invalidated facts: {ids}": "已失效的事实：{ids}",
  "The task cannot resume automatically and remains in needs_attention.":
    "任务无法自动恢复，仍处于 needs_attention。",
  'task {taskId} resumed; status is now "{status}"': '任务 {taskId} 已恢复；当前状态为 "{status}"',

  // `task branch`.
  "(primary)": "（主分支）",

  // `task compare`.
  "This task has {count} branch(es); at least two are needed to compare. Create another branch with `keystone task branch`.":
    "该任务有 {count} 个分支；比较至少需要两个分支。请使用 `keystone task branch` 创建另一个分支。",
  "outcome": "结果",
  "verification": "验证",
  "changed": "变更",
  "residual": "残余",
  "tokens": "令牌",

  // Command summary (`keystone --help`).
  "Run tasks, and inspect/recover/branch/compare them": "运行任务，并检查 / 恢复 / 派生分支 / 比较",
};
