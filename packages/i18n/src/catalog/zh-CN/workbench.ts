/**
 * Workbench UI strings, injected into `workbench.html` as `window.KEYSTONE_I18N`.
 *
 * Keys are the English source strings that appear in the page. A few are built
 * dynamically — task statuses, execution stages, task groups, checkpoint reasons
 * and proof reason codes travel as protocol values and are translated here by
 * their machine name, because the page must not carry a second copy of the
 * wording.
 */

import type { Catalog } from "../../types.ts";

export const workbench: Catalog = {
  // Document title, brand and title bar.
  "Keystone — task workbench": "Keystone — 任务工作台",
  "task workbench": "任务工作台",
  "no project selected": "未选择项目",
  "Local data": "本地数据",
  Refresh: "刷新",
  "Switch to light theme": "切换到浅色主题",
  "Switch to dark theme": "切换到深色主题",
  "mode {mode}": "模式 {mode}",

  // Task statuses (PRD 7.1) and the neutral idle state.
  idle: "空闲",
  draft: "草稿",
  defining: "定义中",
  ready: "待开始",
  awaiting_approval: "待确认",
  executing: "执行中",
  verifying: "验证中",
  auto_repairing: "自动修复中",
  needs_attention: "需要处理",
  paused: "已暂停",
  resuming: "恢复校验中",
  proven: "已证明",
  exited_gracefully: "有序退出",
  failed: "失败",
  stopped: "已停止",
  unrecoverable: "无法恢复",

  // Execution stages (PRD EX-01, UI-03). Prefixed so a phase and the task state
  // of the same name can read differently ("verify" vs "verifying").
  "stage-understanding": "理解",
  "stage-planning": "规划",
  "stage-authorizing": "授权",
  "stage-modifying": "修改",
  "stage-verifying": "验证",
  "stage-delivering": "交付",

  // Task list groups (PRD UI-02).
  "Needs you": "需要处理",
  Running: "运行中",
  Waiting: "等待",
  Proven: "已完成",
  Exited: "已退出",

  // Static section headings, labels and empty states.
  Projects: "项目",
  "All projects": "全部项目",
  "No projects yet.": "尚无项目。",
  Tasks: "任务",
  "No tasks yet. Start one below.": "尚无任务。在下方启动一个。",
  "Cognition and experience": "认知与经验",
  "Select a task to inspect what it was told.": "选择一个任务，查看它被告知了什么。",
  "Goal and scope": "目标与范围",
  "No task selected.": "未选择任务。",
  "Completion conditions": "完成条件",
  "No contract yet.": "尚无契约。",
  "Stage and trace": "阶段与追踪",
  "No events yet.": "尚无事件。",
  "show raw events": "显示原始事件",
  Proof: "证明",
  "No proof yet.": "尚无证明。",
  Evidence: "证据",
  "No evidence recorded.": "尚未记录证据。",
  "Branches and checkpoints": "分支与检查点",
  "No branches yet.": "尚无分支。",
  "No checkpoints yet.": "尚无检查点。",
  "Needs your decision": "需要你的决策",
  "Nothing waiting.": "没有待处理事项。",
  workspace: "项目目录",
  task: "任务",
  "Describe the task…": "描述任务…",
  "write paths": "写入路径",
  "Start task": "开始任务",
  Pause: "暂停",
  Stop: "停止",
  "Add constraints": "补充约束",
  "View change": "查看改动",
  "Export proof": "导出证明",

  // Goal and scope.
  "Ledger integrity check failed: {reason}": "账本完整性校验失败：{reason}",
  "Degraded to {mode}: {reason}": "已降级至 {mode}：{reason}",
  "contract v{version}": "契约 v{version}",
  "{n} events": "{n} 个事件",
  "{n} evidence": "{n} 条证据",
  "replay consistent": "重放一致",
  "replay inconsistent": "重放不一致",
  "proof {hash}": "证明 {hash}",
  Invariants: "不变量",
  "Open questions in the contract": "契约中的未决问题",
  "Write scope": "写入范围",
  "Read scope": "读取范围",
  "(nothing writable)": "（无可写内容）",

  // Completion conditions and proof reason codes.
  satisfied: "已满足",
  "not evaluated": "未评估",
  no_evidence: "无证据",
  insufficient_level: "证据等级不足",
  evidence_invalid: "证据已失效",
  not_independent: "不满足独立性",
  scope_exceeded: "超出范围",
  workspace_changed: "工作区已变化",
  dependency_unsatisfied: "依赖条件未满足",
  verifier_failed: "验证器失败",
  pending: "等待中",
  condition_removed: "条件已移除",
  required: "必需",
  auxiliary: "辅助",
  "min {level}": "最低 {level}",
  "achieved {level}": "已达 {level}",
  "independent: yes": "独立：是",
  "independent: no": "独立：否",

  // Trace summary and checkpoints.
  Stage: "阶段",
  Steps: "步数",
  "Changed files": "改动文件数",
  Checkpoints: "检查点",
  "Run branch": "运行分支",
  "Latest checkpoint": "最新检查点",
  "Latest lease": "最新能力租约",
  "Last action": "最近动作",
  "Context plan": "上下文计划",
  "{items} items · {tokens} tokens": "{items} 项 · {tokens} token",
  stage_boundary: "阶段边界",
  before_side_effect: "副作用之前",
  pre_verification: "验证之前",
  pre_branch: "派生分支之前",
  periodic: "周期性",
  user_requested: "用户请求",
  "from {id}": "来自 {id}",

  // Proof panel.
  "Safe to deliver": "可以安全交付",
  "Not provable yet": "尚不可证明",
  "Every required condition has valid evidence at the required level.":
    "每一条必需条件都具备达到规定等级的有效证据。",
  "{n} of {total} required conditions are unsatisfied.": "{total} 条必需条件中有 {n} 条尚未满足。",
  "All changes are inside the agreed scope.": "所有改动都在约定的范围内。",
  "Changes exceeded the agreed scope: {items}": "改动超出约定范围：{items}",
  "Proof invalidated: {reason}": "证明已失效：{reason}",
  Outcome: "结论",
  "In scope": "在范围内",
  Generated: "生成时间",
  "Reproduce steps": "复现步骤",
  yes: "是",
  no: "否",
  "Changed paths": "改动路径",
  Unverified: "未验证项",
  "Residual risks": "残留风险",
  "Reproduce commands": "复现命令",
  Summary: "摘要",
  none: "无",

  // Evidence.
  "Evidence {level}": "证据 {level}",

  // Interventions.
  "Waiting for you": "等待你的决策",
  "Why you: {text}": "为何需要你：{text}",
  "If ignored: {text}": "若不处理：{text}",
  "Recommended: {label}": "建议：{label}",
  Context: "上下文",
  allow: "允许",
  deny: "拒绝",
  "Decision recorded": "决策已记录",
  "{n} pending": "{n} 项待处理",
  "{n} waiting": "{n} 项待处理",

  // Cognition and experience.
  Branches: "分支",
  "Experience reused": "复用的经验",
  Promoted: "已晋升",
  "Quarantined candidates": "隔离中的候选经验",
  Demoted: "已降级",
  "{n} project facts marked stale by this task": "本次任务使 {n} 条项目事实待更新",
  "Experience not reused": "未复用的经验",

  // Cost line.
  "{tokens} tokens · {retries} retries · {wall}": "{tokens} token · 重试 {retries} · 耗时 {wall}",
  "budget {tokens} tokens · up to {retries} retries": "预算 {tokens} token · 重试上限 {retries}",

  // Task actions.
  "Revise the contract of the running task": "修订运行中任务的契约",
  "A revision applies only while the task is working": "只有在任务运行中才能修订契约",
  "Task started.": "任务已启动。",
  "Task is now {status}.": "任务当前状态：{status}。",
  "{action} requested; the run will apply it at its next step.": "已请求{action}；运行将在下一个步骤边界应用。",
  "A revision creates a new contract version. Evidence produced under an earlier version stays on the record but only counts if it still satisfies the new version.":
    "修订会生成新的契约版本。旧版本下产生的证据仍会保留，但只有仍满足新版本要求时才能使用。",
  Goal: "目标",
  "Write scope (comma separated)": "写入范围（逗号分隔）",
  "Why (recorded with the revision)": "修订原因（会记录在案）",
  "Clarify the target result": "澄清目标结果",
  Cancel: "取消",
  "Send revision": "提交修订",
  "Revision queued; the run will apply it at its next step.": "修订已排队；运行将在下一个步骤边界应用。",

  // Diff viewer.
  "Change produced by this task": "本次任务产生的改动",
  "Diff recomputed from {path}, limited to the paths this task changed.":
    "差异基于 {path} 重新计算，并限定为本次任务改动的路径。",
  "No diff is available.": "暂无可用差异。",
  "The repository reports no change for these paths.": "仓库报告这些路径没有变化。",
  Close: "关闭",

  // Data management.
  "Stored under {home}. Keystone never writes to your repositories.":
    "数据存放在 {home}。Keystone 不会写入你的代码仓库。",
  "Projects · {n}": "项目 · {n}",
  "Tasks · {n}": "任务 · {n}",
  Project: "项目",
  Facts: "事实",
  "Experience (entries / candidates)": "经验（已晋升 / 候选）",
  Size: "大小",
  Task: "任务",
  Events: "事件数",
  Other: "其他",
  Artifacts: "内容寻址工件",
  Total: "合计",
  "Clear experience": "清空经验缓存",
  Delete: "删除",
  "Cleared {n} experience entries.": "已清空 {n} 条经验。",
  "Deleted task history ({n} events).": "已删除任务历史（{n} 个事件）。",

  // Ledger event titles.
  "Task created": "任务已创建",
  "Status {from} to {to}": "状态 {from} → {to}",
  "Task started": "任务已开始",
  "Contract compiled": "契约已编译",
  "Contract revised": "契约已修订",
  "changed: {fields}": "变更字段：{fields}",
  "{items} items, {tokens} tokens": "{items} 项，{tokens} token",
  "Degraded to {mode}": "已降级至 {mode}",
  "Proposed {tool}": "提议调用 {tool}",
  "Executed {tool}": "执行结果 {tool}",
  "Action refused": "动作被拒绝",
  "Scope violation": "范围越界",
  Checkpoint: "检查点",
  "Branch forked": "已派生分支",
  "Workspace conflict": "工作区冲突",
  "Verification started": "开始验证",
  "Verification failed": "验证失败",
  "Evidence invalidated": "证据已失效",
  "Repair attempt {n}": "第 {n} 次修复尝试",
  "Proof satisfied": "证明已满足",
  "{n} conditions": "{n} 条条件",
  "Proof not satisfied": "证明未满足",
  "Exited gracefully": "已有序退出",
  "unsatisfied: {items}": "未满足：{items}",
  Paused: "已暂停",
  Stopped: "已停止",
  "Experience promoted": "经验已晋升",
  "Candidate experience quarantined": "候选经验已隔离",
  "Experience demoted": "经验已降级",
  "Project facts invalidated": "项目事实已失效",
  "Error recorded": "已记录错误",

  // Confirmations and the completion receipt.
  "{n} of {total} required conditions are not yet satisfied.":
    "{total} 条必需条件中尚有 {n} 条未满足。",
  "The task finished, but its proof is not complete.": "任务已结束，但证明尚不完备。",
  Cost: "消耗",
  "Required conditions": "必需条件",
  "Not yet satisfied": "尚未满足",
  "Delete task history": "删除任务历史",
  "This permanently removes the local record of task {task} ({status}): {events} events, {checkpoints} checkpoints and {size}. This cannot be undone.":
    "将永久删除任务 {task}（{status}）的本地记录：{events} 个事件、{checkpoints} 个检查点、{size}。此操作不可撤销。",
  "This resets the learned experience for {name}: {entries} promoted entries and {candidates} candidates ({size}) are dropped. Task history and your code are untouched; Keystone will simply re-learn next time.":
    "将重置 {name} 已学到的经验：删除 {entries} 条已晋升经验、{candidates} 条候选（{size}）。任务历史和你的代码不受影响；下次会重新学习。",

  // Startup and placeholder copy.
  "/path/to/git/project": "/path/to/git/project",
  "src/**": "src/**",
  "No token in the URL. Open the URL printed by `keystone serve`, which includes the token fragment.":
    "URL 中没有令牌。请打开 `keystone serve` 打印的 URL，其中包含令牌片段。",

  // Risk-graded startup (ADR-0013).
  "Confirm every write task (never auto-start)": "对所有写任务都要求确认（绝不自动开始）",
  "Why this needs confirmation": "为什么需要确认",
  "Open questions — what 'done' means is not yet pinned down.":
    "存在待澄清问题——尚未确定“完成”的含义。",
  "Unresolved or wider scope than the paths you named.":
    "范围未确定，或超出了你指定的路径。",
  "The envelope permits non-reversible actions.":
    "权限边界允许不可撤销的操作。",
  "Side effects can reach the network or external systems.":
    "副作用可能触达网络或外部系统。",
  "Destructive commands or an unbounded write scope.":
    "包含破坏性命令，或写范围无边界。",
  "Your setting or this project's policy requires confirmation.":
    "你的设置或本项目策略要求确认。",
  "Your working tree has uncommitted changes in the files this task would write.":
    "你的工作区中，本任务将要写入的文件存在未提交改动。",
  "This task will not start": "该任务不会启动",
  "This task is refused for this working copy.": "该任务被拒绝在此工作副本上运行。",
  "Started automatically — graded low-risk (no open questions, scoped writes, no external or irreversible actions). You can pause or stop it any time.":
    "已自动开始——评级为低风险（无待澄清问题、写范围受限、无外部或不可逆动作）。你可随时暂停或停止。",
};
