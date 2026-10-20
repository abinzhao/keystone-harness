# Keystone 下一代产品战略 / PRD
## 从「证据原生的工程 Agent Harness」演进为「通用、可定制的智能体基础」

> **文档版本**：v2.0（下一代战略版）
> **基线仓库**：`abinzhao/keystone-harness`
> **锁定提交**：`79ddf698580cc666ba9cb6d7bf8ada44e9ff0842`（`feat(runtime): usable task workbench with task-scoped diff, run control and data management`）
> **成文日期**：2026-10-20
> **语言**：简体中文（协议字段、事件类型、Schema 校验路径、证明包保持英文机器格式，字节级与语言无关）
> **许可**：Apache License 2.0

---

### 阅读约定：三档状态标签

本文严格区分三档能力，避免把规划说成既成事实：

| 标签 | 含义 | 判定标准 |
|---|---|---|
| **【现状 · 已实现】** | 已在锁定提交的代码库中落地并有测试/浏览器验证 | 可被 `pnpm verify`、浏览器工作台实测复现 |
| **【下一步 · P1】** | 已在官方 `ROADMAP.md` / PRD 4.2 立项，尚未实现 | 是计划内、有验收口径的近期工作 |
| **【探索 · P2】** | 方向明确但尚未立项拆解 | 面向长期、需外部条件成熟的探索 |

> **诚信红线**：本文不把任何 P1/P2 能力描述为「现在就能用」。桌面外壳（Tauri）、Git 写操作、Windows 端到端、工作区扫描性能等缺口均如实标注。

---

## 0. 一页纸摘要（TL;DR）

> **当前阶段定性（务必先读）**：Keystone 现在是一个**开发者预览版（Developer Preview）、CLI 优先**的工程 Agent Harness。它已在真实 Git 仓库上端到端跑通核心闭环，但**面向普通用户的桌面应用尚未实现**——目前只有无界面 CLI + 本地回环的四区 Web 工作台（供人审阅/人工介入），Tauri 原生桌面外壳是下一步计划，不是现状。

- **现在的 Keystone** 是一个**证据原生、本地优先的工程 Agent Harness**：在真实 Git 仓库上跑通「 onboard → 定契约 → 执行 → 校验 → 出证明 → 隔离经验」的闭环；任务只有在每条必需条件都拿到规定等级的**有效证据**时才进入 `proven`，模型口头说「完成」不算数。
- **模型接入现状**：当前仅支持 **OpenAI Chat Completions 兼容（`POST {baseUrl}/chat/completions`）的文本补全**，不依赖任何厂商 SDK；原生 Responses API、原生 tool-calling、Anthropic / Gemini 原生协议均为**计划方向，不是现状**。
- **下一代要做的事**：把已经稳定的**最小可信内核（内部代号「太初核 / Taichu Kernel」）**从「只服务软件工程任务」解放为「任意领域智能体都能挂载的通用基础」——内核负责状态权威、权限租约、证据与预算，模型、工具、验证器、Skill、客户端全部变成**受治理的可替换扩展**。
- **不变的东西（核心承诺）**：内核唯一写权威、事件溯源可重放、每个副作用要短时效能力租约、长期经验过经验防火墙、自治只在用户硬边界内增减。
- **不做的事**：不做以「堆 Agent 数量」为目标的软件工厂、不做中心化企业 Web 后台、不做无隔离无一致性测试的插件市场、不让扩展替换状态机/权限签发/证据完整性/完成判定。
  - **领域边界的准确说法**：今天**只实现了软件工程这一个垂直**；个人、研究、创作、企业、设备/机器人等场景是**未来的能力包（scenario packs）**，由同一套原语 + 领域验证器/工具组装，不是 Keystone 今天已经做出来的 App。
- **更强模型来了怎么办**：只换 L2/L3「认知扩展包」和模型适配器，**不动内核一行**；成本与质量结构性解耦。

---

## 1. 定位（Positioning）

### 1.1 一句话定位

> **Keystone 是一个本地优先、证据原生的智能体基础：它持续理解一个目标系统，在用户明确设定的硬边界内完成复杂任务，并用可重放、可审计的证据——而不是模型的自我声明——证明结果可交付。**

### 1.2 从 Harness 到 Foundation 的跃迁逻辑

【现状 · 已实现】Keystone 当前的差异化**不在功能清单**——统一运行时、多客户端、Skills/插件/Hooks、权限与沙箱、会话持久化与分支、worktree、子 Agent、项目规则与记忆、测试与评审、Manual/Plan/Auto、历史经验复用，这些在 2026 年已是主流工程 Agent 的**市场共识基线**（见仓库 `docs/research/2026-10-19-agent-harness-competitive-analysis.md`）。

Keystone 真正的护城河是**把 Contract（结果契约）/ Lease（能力租约）/ Proof（证明图）这组语义，用一张可分叉的运行图贯穿任务、工作区、证据与经验**。这组语义与「软件工程」这个具体领域是解耦的：

- 换一套**领域验证器**（从 `test/typecheck/lint/build` 换成「财报勾稽校验」「机器人运动学约束」「合同条款比对」），同一套内核就能服务新领域。
- 换一套**工具/能力出口**（从文件/git 换成 MCP 服务、设备执行器、传感器），内核的 gated 执行、预算、回滚语义不变。

因此下一代的产品定位是：**把「工程 Harness」验证过的可信内核，抽象成「通用可定制智能体基础」**，工程场景成为它的第一个、也是最严苛的参考实现。

### 1.3 目标用户与价值主张

| 人群 | 现在的痛点 | Keystone 提供的价值 |
|---|---|---|
| 资深工程师 / Tech Lead | 模型说「做完了」但跑不通；任务中途崩溃无法恢复；换模型结果不可复现 | 完成=证据图的确定性查询；事件账本可重放；断点可恢复；模型可热切换而业务状态不变 |
| 平台 / 内部工具团队 | 想给不同业务挂不同 Agent，但每个都要重做安全、权限、审计 | 直接挂载 Keystone 内核：权限租约、预算硬停、人审、重放开箱即用 |
| 对隐私/合规敏感的用户 | 代码与数据不能出本机/本环境 | 本地优先运行时 + BYOK；可选纯本地模型，数据不出回环 |
| 扩展/生态贡献者 | 改 Agent 能力要碰核心、怕改坏安全模型 | 受治理扩展 SDK：清单 + 完整性 + 一致性套件，隔离沙箱，不碰内核 |

---

## 2. 非目标（Non-Goals）—— 明确不做

> **关于领域范围的更正**：Keystone **不把「个人 / 研究 / 创作 / 企业 / 设备·机器人」列为永久非目标**。今天只交付了软件工程垂直；其余场景是挂在同一套内核原语上的**未来能力包**。下列非目标约束的是「做事方式与可信度红线」，不是「永不碰某类人群」。

1. **不做以「Agent 数量」为目标、默认开启的多 Agent 软件工厂**；子 Agent 必须「收益可证」才启用，且上下文与权限隔离。
2. **不做中心化企业 Web 管理后台**。
3. **不做移动端客户端与远程签名**。
4. **不做自动付款、自动发邮件、自动生产部署**这类高爆炸半径动作。
5. **不做无隔离、无一致性测试、无权限声明的插件/Skill 市场**。
6. **不把单次失败自动升级为长期项目规则**（经验晋升必须过防火墙）。
7. **不允许扩展替换状态机、权限签发、证据完整性或完成判定**。
8. **不把模型的思维链（CoT）当作证明、审计记录或交付物**——CoT 是数据，不是命令，更不是证据。

> 非目标不是「永远不做」，而是「不在本期用牺牲内核可信度的方式去做」。任何越界需求都必须先回答：它是否动摇了内核的不可变不变量？

---

## 3. 稳定核心抽象（Stable Core Abstractions）

> 这是下一代**永不轻易破坏**的部分。模型/工具/验证器/Skill/客户端/协议适配器都可替换，下面这组抽象保持语义稳定（对应仓库 `packages/kernel` 与 ADR-0001..0005）。

### 3.1 已落地的内核模块【现状 · 已实现】

| 抽象 | 职责 | 不可逾越的规则 |
|---|---|---|
| **事件账本 Event Ledger** | 追加不可变、哈希链、唯一事实源；重放即复现权威状态 | 内核是唯一写入者；扩展只能提交「意图/观测」，不能直接写状态 |
| **状态机 State Machine** | `draft → ready/awaiting_approval → executing → proven / needs_attention / exited_gracefully` 等合法迁移 | 迁移表受控；模型文本不能触发状态跃迁 |
| **结果契约 Outcome Contract** | 目标、范围、不变量、完成条件、证据等级要求、预算、自治边界、不确定项、干预条件、退出条件 | 可编译、版本化、导入导出；换模型不改变契约与完成判定 |
| **能力租约 Capability Lease** | 每个副作用都要一份**有范围、短时效、可撤销**的租约 | 越界写即暂停并可被拒绝；扩展无权自我授权 |
| **运行图 Run Graph** | 节点/边、检查点、分支派生、分支比较、恢复 | 分支连接的是工作区+证据+经验，不是复制聊天 |
| **溯源 Provenance** | 每条事实的来源、信任级、派生关系、污染传播、失效条件 | 上下文/记忆/证据都保留来源与失效规则 |
| **证据 Evidence（E0–E4）** | 分级证据记录与独立性判定 | E0 模型自述**不能单独**满足完成条件 |
| **证明图 Proof Graph** | 完成判定是对证据依赖图的一次**确定性查询** | 全部必需条件达到规定等级且未失效、未越界、链路完整、无环/无冲突，才 `proven` |
| **经验防火墙 Experience Firewall** | 候选经验先隔离、默认不进后续任务，晋升需独立验证/用户确认/可从项目事实推导 | 评估正迁移、负迁移与遗忘，可降级、可撤销 |
| **自治包线 Autonomy Envelope** | 用户按项目设定的最大硬边界（文件/命令/网络/凭据/外部系统/可逆性/预算） | 模型、插件、历史成功、项目内容**都不能自动扩大**它 |

### 3.2 双环架构

- **Builder Loop**：理解 → 规划 → 编辑 → 执行。
- **Assurance Loop**：结果 → 上下文 → 能力 → 验证 → 完成判定 → 学习 → 自治。
- 两个环都写同一张可分叉运行图；**只有内核能改权威状态、签发租约、接受证据、判定完成、晋升经验**。

### 3.3 四种运行模式（含降级）【现状 · 已实现】

| 模式 | 能力 | 用途 |
|---|---|---|
| `minimal` | 仅基础文件、独立命令、确定性验证（不调用模型） | 评测、诊断、故障隔离、安全降级；第三方扩展全挂时仍可用 |
| `standard` | 项目理解、上下文规划、工具、验证、经验 | 默认 |
| `isolated` | 在独立 Git worktree 中执行，工作副本不被触碰 | 高风险任务 / 需复现任务 |
| `replay` | 只做状态/验证/执行重放 | 一致性检查与审计 |

> 降级必须**显式声明能力损失与对证据等级的影响**，严禁「静默降级后仍宣称同等证明强度」。

---

## 4. 双轨：普通用户轨 vs 开发者轨

### 4.1 普通用户轨（Workbench / 使用者）

> **诚信标注**：Keystone 当前是 **CLI 优先的开发者预览版**。**普通用户轨的完整产品形态尚未实现**——没有打包好的桌面 App，普通用户现在不应被预期为目标受众。

【现状 · 已实现（仅作审阅/介入面，非成品桌面应用）】已交付**本地 Run Protocol 服务 + 四区工作台单页**，并在真实浏览器验证过渲染与数据：
- 服务仅监听回环地址，打印 bearer token；URL 把 token 放在 fragment（浏览器不会把 fragment 发给服务器）。
- 四区：任务列表 / 目标与完成条件 / 证明与证据 / 人工介入回答区。
- 服务端按解析出的语言注入文案目录（`zh-CN` 默认 / `en`）。
- 无构建步骤、无依赖——因为未来桌面外壳要封装的就是它。

【下一步 · P1 / 桌面外壳】Tauri 薄封装：原生窗口、菜单、托盘、深链、签名与公证。
> **诚信标注**：【现状】**Tauri 打包、签名/公证、原生窗口与系统集成都尚未实现**；计划中的 Tauri 只是对已有工作台的薄封装，不是另起炉灶。

**普通用户的目标体验（均为【下一步/探索】规划，未实现）**：
- **零配置启动**：打开即用，无需手动装模型、配端点；内置可用默认路径（本地优先），有云密钥再走 BYOK。
- **渐进式披露（progressive disclosure）**：默认只给「目标 → 在做什么 → 完成了吗」三层；预算、证据图、事件账本按需展开，不把内核细节甩给用户。
- **预览（previews）**：改代码/改文档前先给「将要变更什么」的 diff 预览，确认后再落盘。
- **回执（receipts）**：每个交付物附一份人可读的完成回执——凭什么算完成、跑了哪些验证、花了多少 token，而不是一句「完成」。
- **异常优先决策（exception-first）**：只在越界、高爆半径或不确定性超阈值时打断用户；其余在硬边界内自行完成。
- **撤销 / 重放（undo & replay）**：任意任务可回滚到检查点、可重放全过程、可从检查点派生分支对比。

### 4.2 开发者轨（CLI / SDK / 扩展作者）—— 当前主力形态

【现状 · 已实现】
- 无界面 CLI：`project inspect`、`task run`、`replay`、`proof show`、`protocol export`（每个对象的 JSON Schema）。
- BYOK 模型接入：**当前仅为 OpenAI Chat Completions 兼容的文本补全**（`POST {baseUrl}/chat/completions`），不依赖任何厂商 SDK；因此 OpenAI 官方 API、Azure OpenAI 兼容网关、OpenRouter，以及本地运行的 Ollama / LM Studio / vLLM / llama.cpp / LocalAI 等**只要讲同一套 Chat Completions 协议就能接**。云端端点 `--kind cloud` 需凭据；自托管端点 `--kind local` 通常无需凭据。
- 密钥从 stdin 读入、仅属主可读、绝不落配置文件。
- 确定性 scripted 模型用于离线评测，如实报告零 token 消耗而非估算。
- 扩展 SDK：清单校验、完整性、安装审查、一致性套件、注册表；附带可照抄的参考扩展 `@keystone/extension-no-debug-statements`。

> **能力边界（不要误述）**：【现状】**没有**原生 OpenAI Responses API 适配、**没有**依赖厂商原生 tool-calling 协议的集成、**没有** Anthropic / Gemini 原生 SDK 协议适配；这些属于互操作方向（见 §8.3），是计划而非现状。

【下一步 · P1】ACP 兼容 IDE 集成、非交互式 CI 运行、多本地项目统一管理、worktree/独立工作区隔离的并行写任务、Project Analyzer / Workspace Runtime / Protocol Adapter SDK、MCP 与 Agent Skills 集成、Harness Lab。

【探索 · P2】A2A 兼容的远端 Agent 委派、远端/集群 Workspace Runtime、团队共享规则/经验/证明、签名证明与跨机重放、能力生态。

---

## 5. 场景矩阵（Scenario Matrix）

> Keystone 不是「只做软件工程」，而是「**今天只把软件工程垂直做穿**」。其余五类场景（个人 / 研究 / 创作 / 企业 / 设备·机器人）是挂在同一套原语上的**未来能力包**。✅=已实现，🟡=P1，⚪=P2 探索/需闸门，✗=明确不做。

| 场景族 | 今天状态 | 内核闭环 | 证据完成 | 本地私有 | 备注 |
|---|---|---|---|---|---|
| **软件工程**（缺陷修复/重构/测试/前端/跨模块） | **已实现垂直** | ✅ | ✅ | ✅ | 参考实现；长任务恢复、高风险 isolated 均已通 |
| **个人**（个人知识整理、待办、私人助手） | 未来能力包 | ⚪ | ⚪ | ✅ | 复用同一原语；成品 App 未做 |
| **研究**（文献梳理、假设-验证、溯源） | 未来能力包 | ⚪ | ⚪（证据=引用与实验记录） | 🟡 | 事实账本天然适配「主张-证据」 |
| **创作**（长文/素材/多稿迭代） | 未来能力包 | ⚪ | ⚪（验收=预览与用户判定） | 🟡 | 完成判定不能由模型自评 |
| **企业**（跨业务复用同一内核） | 未来能力包 | 🟡（换验证器/工具即可） | 🟡 | 🟡 | 多项目统一管理在 P1 |
| **设备 / 机器人**（IoT、物理执行） | **需闸门，不默认 P1** | ⚪ | ⚪ | 🟡 | 见下方安全约束 |
| 跨团队远端 Agent 协作（A2A） | 探索 | ✗ | ✗ | ✗ | P2，需协议稳定+真实用例 |

### 5.1 共享原语矩阵（Shared-Primitives Matrix）

> 这是「一套内核、多场景包」的证据：六类场景共用同六个原语，差异只在**领域验证器与工具出口**，不在内核。

| 场景族 → | 个人 Personal | 软件工程 SWE | 研究 Research | 创作 Creation | 企业 Enterprise | 设备·机器人 Robotics |
|---|---|---|---|---|---|---|
| **Goal / Contract（目标契约）** | 把模糊意图编译成可判定目标 | 缺陷/功能的完成条件 | 研究问题与待证假设 | 稿件/素材的验收标准 | 跨业务统一 SLA 与范围 | 任务目标 + 安全禁区 |
| **Context / Memory（上下文/记忆）** | 个人笔记与偏好（带失效） | 项目世界模型 | 文献库与假设图 | 风格/品牌基线 | 项目规则共享 | 世界模型投影（occupancy/运动学） |
| **Capability（能力出口）** | 本地文件/日历检索 | fs/git/命令工具 | 检索/抓取/文献解析 | 文件/导出工具 | MCP 业务系统 | **设备适配器**（必装） |
| **Policy / Lease（策略/租约）** | 只读默认、少副作用 | 写范围租约、越界暂停 | 出站白名单 | 写范围、导出审批 | 分级权限、审计 | **硬实时安全联锁在模型之外** |
| **Evidence / Receipt（证据/回执）** | 完成回执 | test/typecheck/lint/build 证据 | 引用 + 可复现实验 | 预览 + 用户签收 | 可审计操作记录 | 传感器读数 + 执行校验 |
| **Exception / Human（异常/人审）** | 低爆半径，静默可恢复 | 越界即暂停 | 假设冲突提请裁决 | 审美/方向决策交人 | 高爆半径强制审批 | **安全急停永远要人/硬件兜底** |

> **机器人特别约束**：硬实时安全联锁（急停、力/速度限幅、碰撞规避）必须在**模型之外的确定性硬件/固件层**实现，模型只在其约束内提提案；且必须先有**设备适配器 + 一致性测试 + 安全闸门评测**这道前置闸门，才进入排期——不默认归入 P1。

---

## 6. 更强模型就绪性（Stronger-Model Readiness）

**这是下一代最核心的架构赌注：模型在快速变强，内核必须「永远不必为更强模型重写」。**

### 6.1 已具备的解耦机制【现状 · 已实现】

- **模型适配器统一 `complete()` 接口**：换模型 = 换适配器/路由，不触碰任务的业务状态与完成契约（`NFR-REL-04`，见 §7.7 澄清）。
- **内核无 LLM**：可信内核不调用模型、不访问网络；模型与扩展只产生「动作提案 ActionProposal」。
- **路由层**：Builder 与 Assurance 可路由到不同模型（`model route builder ...`）。
- **现状边界**：当前适配器族是 **OpenAI Chat Completions 兼容文本补全**；更强/更新模型只要讲这套协议即可被接入，无需改内核。原生 Responses、原生 tool-calling、多厂商原生协议为后续适配器扩展点。

### 6.2 下一代的「成本/质量漏斗」设计【下一步 · P1 落地】

把认知拆成四级，让**廉价候选 → 廉价评分 → 仅 top-k 进昂贵强模型**：

| 级 | 名称 | 作用 | 成本 |
|---|---|---|---|
| L0 | 反射 Reflex | 模式匹配 / 缓存决策，零 LLM 调用 | 毫秒级 |
| L1 | 校验 Verify | 小模型提案 + 证据核对，提交前闸口 | 低 |
| L2 | 推演 Deliberate | 强模型规划 / 多步工具，预算内分解 | 中 |
| L3 | 关键 Critical | 多候选 + 自洽 + 人审 + 预设回滚补偿 | 高 |

> **结论**：未来出现更强、更贵的模型，只替换 L2/L3 这个「认知扩展包」和模型适配器，**内核零改动**。成本与质量因此被结构性解耦。

### 6.3 趋势判断（已验证 vs 预测，见 §12）

- 【已验证】模型能力越强，越需要一个**不依赖模型自律**的外部约束层——否则强模型的强能力会同时放大越界风险。这是 Keystone 把预算/权限/完成判定放进「无 LLM 内核」的根本理由。

---

## 7. 非功能需求（NFR）

### 7.1 成本（Cost）

- 【现状】所有副作用、token、时间、副作用次数纳入预算治理；预算硬停由**内核强制**，不是模型自律。
- 【下一步】低成本候选漏斗（§6.2）、按任务/按服务的预算配额与可视化、离线 scripted 模型零成本评测。
- 【探索】能耗级预算指标。

### 7.2 延迟（Latency）

【现状 · 有数据】`docs/performance/baseline-2026-10-19.md`（Apple M3 Pro / Node 22.22 / 20 任务约 85 事件）：

| 指标 | p95 | 对照目标 | 结论 |
|---|---|---|---|
| `cli.cold-start`（启动到 `doctor`） | 173.9 ms | — | 本地路径极快 |
| `cli.task-list`（列 20 个持久任务） | 166.1 ms | NFR-PERF-01 工作台冷启 ≤1.5s | 数量级达标，**但严格未验证**（见下） |
| `kernel.task-switch`（开任务+折叠账本+出摘要） | 1.6 ms | NFR-PERF-02 ≤300ms | **达标**（仅数据层，不含渲染） |
| `proof.open`（从账本重推证明） | 1.2 ms | — | 达标 |

> **诚信标注**：本地数据层开销比需求低两个数量级；真正的延迟风险在 **(a) 工作区扫描**（O(仓库文件数)，本基线未测，故 NFR-PERF-01 **不构成完整验证**）与 **(b) 模型首次往返**（数百毫秒到数十秒）。NFR-PERF-03（增量索引/上下文缓存）属 P1。

### 7.3 隐私（Privacy）

- 【现状】本地优先：运行时数据在被管理仓库之外（`~/.keystone/`，可用 `KEYSTONE_HOME` 覆盖）；凭据仅属主可读；回环监听 + fragment token；可选纯本地模型，数据不出本机。
- 【现状】临时文件用平台临时目录；凭据文件尽力请求仅属主权限（Windows 仅只读位）。
- 【下一步】本地数据查看与清理面板、数据出境在扩展清单中显式声明。
- 【探索】事件级 CRDT 同步下的「离线续跑不泄露」。

### 7.4 安全（Safety）

- 【现状】每个副作用都要 Capability Lease；越界写暂停并可拒绝；外部内容=数据≠命令；高爆炸半径强制人审；扩展崩溃/超时/违反清单即被隔离且保留检查点。
- 【现状】POSIX 上命令执行**从不经过 shell**（防注入）；Windows 上仅 `.cmd` 包管理器经 `cmd.exe` 转义参数，原生 exe 直接 spawn。
- 【下一步/探索】威胁模型公开、发布评分卡、六生命周期阶段安全评测。
- **永不**：扩展不能自授权、不能关安全模式、不能替换完成规则。

### 7.5 可观测（Observability）

- 【现状】执行轨迹、证据级联、证明图、降级记录全部可查；任何一次完成都可追问「凭什么」。
- 【下一步】统一指标导出（验证完成率、人审率、上下文成本、逃逸缺陷率、越界变更率）。
- 【探索】能力晋升管线的可观测性（临时行为为何被晋升为 L0 反射/打包能力）。

### 7.6 重放（Replay）

- 【现状】追加不可变事件账本 + 哈希链；同一事件图重放得到一致权威状态（`NFR-REL-05`）；`replay` 模式做一致性/审计重放；派生投影可清空重建。
- 【现状】证明包是**内容寻址**产物，无论以哪种语言展示都必须字节一致。
- 【探索】跨机重放、签名证明供外部可信核验。

### 7.7 兼容性（Compatibility）

- 【现状】依赖方向单向：`cli → runtime → {kernel, tools, verifiers, models, extensions} → schemas`；`kernel` 不依赖任何执行层，可独立重放。
- 【现状】**换模型保持语义一致 ≠ 结果一致**：`NFR-REL-04` 的准确含义是——切换模型不改变任务的**业务状态、结果契约、完成判定口径与证据规则**；它**不承诺**不同模型产出相同的代码或相同的中间路径。后者本就取决于模型能力，应由 §9 的可复现评测去度量，而不是由内核掩盖。
- 【现状】内核零运行时依赖；直接从 TypeScript 源码运行，无构建步骤；Node ≥ 22.18（原生类型剥离）+ pnpm 8。
- 【现状】跨平台：**macOS 已真机验证；Windows 解析层已实现并过单测，但端到端测试套件尚未在 Windows 机器跑过——Windows 视为预览态。**
- 【现状】Git 写操作（commit/rollback）**尚未实现**；目前是只读 Git 工具 + worktree 隔离。
- 【下一步】Protocol Adapter 不得改变 Contract/Lease/Provenance/Evidence/完成语义；无法表达的语义必须**显式降级或拒绝**，严禁静默丢弃。

---

## 8. 生态治理与开放规范（Governance & Open Specs）

### 8.1 治理现状【现状 · 已实现】

已具备开源就绪文档：`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`GOVERNANCE.md`、`SUPPORT.md`、`ROADMAP.md`、`CHANGELOG.md`、`AGENTS.md`；以及 ADR-0001..0005。

### 8.2 扩展治理红线

扩展安装/升级必须经过：**完整性校验 → 依赖解析 → 一致性测试 → 风险披露 → 用户确认**。扩展不能：自授权、替换内核完成规则、关闭安全模式、新增 Allow 规则。

### 8.3 开放规范路线（在各自恰当边界上使用现有标准）

| 标准 | 用途 | 档位 | 官方来源 |
|---|---|---|---|
| **Keystone Run Protocol** | 结果契约/租约/溯源/证据/证明/检查点/人审 | 【现状】已定义并版本化 | 仓库 `packages/runtime` |
| **OpenAI Chat Completions 兼容** | 当前 BYOK 文本补全接入面 | 【现状】已实现 | openai.com |
| **MCP** | 工具与外部资源接入 | 【下一步】集成 | modelcontextprotocol.io |
| **Agent Skills** | 可复用能力包（按不可信能力输入对待） | 【下一步】集成 | agentskills.io |
| **ACP** | IDE / Agent 客户端集成 | 【下一步】 | agentclientprotocol.com |
| **OpenAI Responses / 原生 tool-calling / Anthropic·Gemini 原生协议** | 更广的模型供应商与工具互操作 | 【探索】计划方向，**非现状** | openai.com / anthropic.com / gemini |
| **A2A** | 远端 Agent 协作 | 【探索】 | a2a-protocol.org |

> 扩展 SDK、Schema、一致性套件、迁移规则、威胁模型、ADR 与发布评分卡将长期保持公开。

---

## 9. 成功度量（Success Metrics）

Keystone **不靠功能数量宣称领先**。稳定版必须在「同模型、同任务、同权限、同时长、同 token 预算」下跨过跨阶段领导力闸门：

1. 在**验证完成率 / 人审率 / 上下文成本**至少一个核心维度上，显著优于当前最佳可复现基线；
2. 逃逸缺陷率、越界变更率、生命周期安全指标**不退化**；
3. 恢复、重放、分支合并都有确定性证据；
4. 开启长期经验后，**正迁移可观测**，负迁移与遗忘不超过发布闸门；
5. 新插件/模型/协议/策略不能破坏 Contract/Lease/Provenance/Evidence/Proof 不变量。

> **原则**：具体数值阈值由公开基线评测决定，**无数据不预设**；任何「领先」表述必须引用当前 scorecard 与可复现实验。评测协议覆盖缺陷修复、约束式功能、重构、测试、前端、跨模块、长任务恢复；跑 Standard 与 Minimal 两档以区分「模型能力」与「Harness 增益」。

---

## 10. 分阶段路线图（Phased Roadmap）

### 【现状 · 已实现】P0：证据原生单项目闭环

- **M0 工程与文档基线** ✅：治理文档、ADR、monorepo、typecheck/test 脚本可跑。
- **M1 无 UI 内核闭环** ✅：onboard/快照、契约编译/版本/导入导出、运行图检查点/分支/恢复/重放、证据等级与证明图、证据失效、有界自动修复、经验防火墙。
- **M2 运行时与 CLI 闭环** ✅：上下文规划、能力租约与统一执行边界、自治包线与人审、六类验证器与预算、证明导出、云/本地模型切换与四模式。
  - ⚠️ **已知缺口**：Git 写操作（commit/rollback）未实现；只读 Git + worktree 隔离。
- **M3 扩展 SDK 与一致性测试** ✅：清单/完整性/安装审查/一致性套件/注册表 + 参考扩展端到端测试。
- **M4 本地工作台** 🟡（部分）：回环 Run Protocol + 四区工作台单页已交付并在浏览器验证；**Tauri 打包/签名/公证/原生窗口与系统集成未完成。**

### 【下一步 · P1】先证有效，再扩表面

> **P1 第一优先级（闸门，不是可选项）**：建立**可复现的功效记分卡 / Harness 增益基线**——固定模型/任务/权限/时长/token 预算，跑 Standard 与 Minimal 双档，把「模型本身的能力」与「Keystone 内核带来的增益」分离度量（验证完成率、人审率、上下文成本、逃逸缺陷率、越界变更率），并随版本发布公开 scorecard。**没有这个可复现度量，P1 其余表面功能不批量铺开。**

P1 在上述闸门成立后，按依赖顺序推进：
1. Tauri 桌面外壳（普通用户轨从「本地 Web 工作台」升级为打包应用）；
2. ACP IDE 集成与非交互 CI 运行；
3. 多本地项目统一管理 + worktree/独立工作区隔离的并行写任务；
4. Project Analyzer / Workspace Runtime / Protocol Adapter SDK；
5. MCP 与 Agent Skills 集成（一律走受治理扩展面）；
6. 增量索引与上下文缓存（闭合 NFR-PERF-01/03，先把工作区扫描测出来）；
7. 经验的正/负迁移与遗忘评测。

**P1 显式退出闸门**：scorecard 可复现且在某一核心维度优于当前最佳可复现基线，同时安全指标不退化、契约/租约/证据不变量不被新扩展破坏，方可进入 P2。

### 【探索 · P2】远端协作与开放生态（设前置条件，避免无投入下的功能蔓延）

P2 仅在 P1 闸门达成、且对应外部生态成熟（协议版本稳定、有真实跨组织协作需求）后启动：
- A2A 兼容远端委派（前置：A2A 协议版本稳定且有可对标的真实用例）；
- 远端/集群 Workspace Runtime（前置：本地单内核 scorecard 已稳固）；
- 团队共享规则/经验/证明、签名证明与跨机重放；
- 验证器/规则/工作区/经验模板生态（前置：扩展一致性套件与安装治理被真实第三方验证过）。

> **克制原则**：P2 不追求一次列全所有表面；每条都有「为什么现在做、前置条件是什么、不满足就不做」的答案。

---

## 11. 核心架构图（Inline SVG）

> 下图为「太初核 Taichu Kernel」目标架构：最小可信内核 + 按需认知扩展 + 能力出口层。绿色=gated 执行放行，琥珀=扩展经 ECA 提交带证据动作提案（不可越界写状态），红色虚线=可信边界。完整可渲染版本见随附 `keystone-next-generation-report.html`。

```svg
<svg viewBox="0 0 1400 1000" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Keystone Taichu Kernel architecture">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#374858"/></marker>
    <marker id="arrAmber" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#b7791f"/></marker>
    <marker id="arrGreen" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#2f7d5b"/></marker>
  </defs>
  <text x="30" y="92" font-size="13" font-weight="700" fill="#5b6b7b">认知扩展层（不可信沙箱 · 可热替换 · 含任意模型）</text>
  <text x="30" y="300" font-size="13" font-weight="700" fill="#b23a3a">可信内核 Trusted Kernel（无 LLM · 唯一状态写入者）</text>
  <text x="30" y="632" font-size="13" font-weight="700" fill="#5b6b7b">能力层 Capability Providers（外部世界出口）</text>
  <g font-size="12" fill="#1f2933">
    <rect x="120" y="110" width="250" height="92" rx="8" fill="#eef2f6" stroke="#9fb0c0"/><text x="245" y="138" text-anchor="middle" font-weight="700">L0 反射 Reflex</text><text x="245" y="158" text-anchor="middle" font-size="11" fill="#5b6b7b">模式匹配 / 缓存决策</text><text x="245" y="176" text-anchor="middle" font-size="11" fill="#5b6b7b">毫秒级 · 零 LLM 调用</text>
    <rect x="400" y="110" width="250" height="92" rx="8" fill="#eef2f6" stroke="#9fb0c0"/><text x="525" y="138" text-anchor="middle" font-weight="700">L1 校验 Verify</text><text x="525" y="158" text-anchor="middle" font-size="11" fill="#5b6b7b">小模型提案 + 证据核对</text><text x="525" y="176" text-anchor="middle" font-size="11" fill="#5b6b7b">提交前闸口复核</text>
    <rect x="680" y="110" width="250" height="92" rx="8" fill="#e7f0ea" stroke="#6fa188"/><text x="805" y="138" text-anchor="middle" font-weight="700">L2 推演 Deliberate</text><text x="805" y="158" text-anchor="middle" font-size="11" fill="#3f6b57">强模型规划 / 多步工具</text><text x="805" y="176" text-anchor="middle" font-size="11" fill="#3f6b57">预算内分解任务</text>
    <rect x="960" y="110" width="250" height="92" rx="8" fill="#fbeee6" stroke="#d08a5a"/><text x="1085" y="138" text-anchor="middle" font-weight="700">L3 关键 Critical</text><text x="1085" y="158" text-anchor="middle" font-size="11" fill="#a85a2a">多候选 + 自洽 + 人审</text><text x="1085" y="176" text-anchor="middle" font-size="11" fill="#a85a2a">预设回滚补偿</text>
  </g>
  <g font-size="10.5" fill="#b7791f"><rect x="680" y="212" width="530" height="34" rx="6" fill="#fff7e6" stroke="#e0b96a" stroke-dasharray="4 3"/><text x="945" y="227" text-anchor="middle" font-weight="700">低成本候选漏斗：大量廉价候选 → 廉价评分 top-k → 仅 top-k 进昂贵模型</text><text x="945" y="241" text-anchor="middle">更强模型只换 L2/L3 包，不动内核</text></g>
  <g stroke="#b7791f" stroke-width="1.6" stroke-dasharray="6 4" fill="none"><line x1="245" y1="202" x2="360" y2="300" marker-end="url(#arrAmber)"/><line x1="525" y1="202" x2="560" y2="300" marker-end="url(#arrAmber)"/><line x1="805" y1="246" x2="800" y2="300" marker-end="url(#arrAmber)"/><line x1="1085" y1="246" x2="1040" y2="300" marker-end="url(#arrAmber)"/></g>
  <text x="690" y="288" font-size="11" fill="#b7791f" text-anchor="middle">ECA 带证据动作提案（扩展不可直接写状态/副作用）</text>
  <rect x="260" y="300" width="880" height="250" rx="12" fill="#fff5f5" stroke="#b23a3a" stroke-width="2" stroke-dasharray="8 5"/>
  <g font-size="12" fill="#1f2933">
    <rect x="300" y="330" width="250" height="100" rx="7" fill="#ffffff" stroke="#b23a3a"/><text x="425" y="356" text-anchor="middle" font-weight="700">事件日志 Event Log</text><text x="425" y="376" text-anchor="middle" font-size="10.5" fill="#5b6b7b">追加不可变 · 哈希链 · 唯一事实源</text><text x="425" y="394" text-anchor="middle" font-size="10.5" fill="#5b6b7b">CRDT 友好 · 可重放</text>
    <rect x="580" y="330" width="250" height="100" rx="7" fill="#ffffff" stroke="#b23a3a"/><text x="705" y="356" text-anchor="middle" font-weight="700">策略引擎 Policy</text><text x="705" y="376" text-anchor="middle" font-size="10.5" fill="#5b6b7b">声明式权限 / 爆炸半径 / 人审阈值</text><text x="705" y="394" text-anchor="middle" font-size="10.5" fill="#5b6b7b">外部内容=数据≠命令</text>
    <rect x="860" y="330" width="250" height="100" rx="7" fill="#ffffff" stroke="#b23a3a"/><text x="985" y="356" text-anchor="middle" font-weight="700">预算治理 Budget</text><text x="985" y="376" text-anchor="middle" font-size="10.5" fill="#5b6b7b">Token/时间/副作用/能耗硬停</text><text x="985" y="394" text-anchor="middle" font-size="10.5" fill="#5b6b7b">内核强制，非模型自律</text>
    <rect x="300" y="445" width="250" height="90" rx="7" fill="#ffffff" stroke="#b23a3a"/><text x="425" y="471" text-anchor="middle" font-weight="700">能力运行时 Capability RT</text><text x="425" y="491" text-anchor="middle" font-size="10.5" fill="#5b6b7b">沙箱派发 · 幂等键 · 补偿声明</text><text x="425" y="509" text-anchor="middle" font-size="10.5" fill="#5b6b7b">仅此处产生真实副作用</text>
    <rect x="580" y="445" width="250" height="90" rx="7" fill="#ffffff" stroke="#b23a3a"/><text x="705" y="471" text-anchor="middle" font-weight="700">状态/投影存储</text><text x="705" y="491" text-anchor="middle" font-size="10.5" fill="#5b6b7b">由事件日志派生 · 可重建</text><text x="705" y="509" text-anchor="middle" font-size="10.5" fill="#5b6b7b">非权威 · 可清空重算</text>
    <rect x="860" y="445" width="250" height="90" rx="7" fill="#ffffff" stroke="#b23a3a"/><text x="985" y="471" text-anchor="middle" font-weight="700">评估器 Evaluator</text><text x="985" y="491" text-anchor="middle" font-size="10.5" fill="#5b6b7b">对照 rubric 评分 / 回归闸门</text><text x="985" y="509" text-anchor="middle" font-size="10.5" fill="#5b6b7b">能力晋升管线入口</text>
  </g>
  <g font-size="12">
    <rect x="120" y="660" width="250" height="90" rx="8" fill="#eef2f6" stroke="#9fb0c0"/><text x="245" y="690" text-anchor="middle" font-weight="700">工具 / MCP 服务</text><text x="245" y="710" text-anchor="middle" font-size="10.5" fill="#5b6b7b">声明式 schema · 权限分级</text><text x="245" y="728" text-anchor="middle" font-size="10.5" fill="#5b6b7b">出站白名单</text>
    <rect x="400" y="660" width="250" height="90" rx="8" fill="#eef2f6" stroke="#9fb0c0"/><text x="525" y="690" text-anchor="middle" font-weight="700">设备 / 执行器 / 传感器</text><text x="525" y="710" text-anchor="middle" font-size="10.5" fill="#5b6b7b">机器人 · IoT · 物理世界</text><text x="525" y="728" text-anchor="middle" font-size="10.5" fill="#5b6b7b">安全闸在 kernel，不在模型</text>
    <rect x="680" y="660" width="250" height="90" rx="8" fill="#eef2f6" stroke="#9fb0c0"/><text x="805" y="690" text-anchor="middle" font-weight="700">模型适配器 Model Adapter</text><text x="805" y="710" text-anchor="middle" font-size="10.5" fill="#5b6b7b">统一 complete() 接口</text><text x="805" y="728" text-anchor="middle" font-size="10.5" fill="#5b6b7b">更强模型=新适配器，零内核改动</text>
    <rect x="960" y="660" width="250" height="90" rx="8" fill="#eef2f6" stroke="#9fb0c0"/><text x="1085" y="690" text-anchor="middle" font-weight="700">人在环 Human-in-Loop</text><text x="1085" y="710" text-anchor="middle" font-size="10.5" fill="#5b6b7b">例外/决策优先 UI</text><text x="1085" y="728" text-anchor="middle" font-size="10.5" fill="#5b6b7b">高爆炸半径强制审批</text>
  </g>
  <path d="M425,535 L425,600 L245,600 L245,660" fill="none" stroke="#2f7d5b" stroke-width="1.8" marker-end="url(#arrGreen)"/><text x="330" y="592" font-size="11" fill="#2f7d5b">gated 执行（策略/前置条件/预算全过才放行）</text>
  <path d="M1085,660 L1085,600 L425,600 L425,430" fill="none" stroke="#374858" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#arr)"/><text x="760" y="592" font-size="11" fill="#374858">Observe 观测 → 追加事件 → 评估 → 投影更新</text>
  <g font-size="11"><rect x="260" y="790" width="880" height="60" rx="8" fill="#f3f0e7" stroke="#b3a06a"/><text x="700" y="815" text-anchor="middle" font-weight="700" fill="#6b5d2f">能力晋升管线（Evaluator → Promotion）</text><text x="700" y="836" text-anchor="middle" font-size="10.5" fill="#5b6b7b">被复用且高分的临时行为 → 晋升为 L0 反射 / 打包能力 / 策略规则；离线回放回归不通过则阻断或降级</text></g>
</svg>
```

---

## 12. 已验证趋势 vs 明确标注的预测

### 12.1 已验证事实（有官方/高置信来源，见 §13）

- **Keystone 自身判断（来自仓库竞品分析文档，非外部独立数据）**：在仓库 `docs/research/2026-10-19-agent-harness-competitive-analysis.md` 中，Keystone 将「统一运行时、多客户端、Skills/插件/Hooks、权限沙箱、会话持久化与分支、worktree、子 Agent、项目规则、测试评审、Manual/Plan/Auto、历史经验复用」列为 2026 年主流工程 Agent 的**市场共识基线**。该结论是 Keystone 自己的产品立场，本文不把它当作独立第三方量化事实来引用。
- MCP 是连接 LLM 应用与外部工具/数据源的开放标准，由 Anthropic 于 2024-11 开源（官方）。
- Agent Skills 由 Anthropic 作为开放格式发布，并于 2025-12-18 宣布作为跨平台可移植开放标准（官方）。
- A2A 由 Google 发起并捐赠给 Linux Foundation，是跨框架 Agent 互操作开放标准（官方）。
- ACP 是代码编辑器与编码 Agent 之间的 stdio 协议，Zed 等采用（官方）。
- Local-first 是被系统阐述的设计范式：本地设备为权威存储、网络可选、数据归用户所有（Ink & Switch）。
- Event Sourcing：状态完全由事件日志派生、可重放重建，是审计/调试/分发的成熟模式（Martin Fowler）。

> 趋势类表述仅保留上述官方/高置信来源；不引用弱聚合站点或未经核实的第三方对比数字。

### 12.2 明确标注的预测（FORECAST，非既成事实）

> 以下是本文基于上述趋势的**判断/预测**，需以后续实测验证，不作为现状陈述：

- **【预测】** 模型推理成本将持续下降但强模型仍显著贵于小模型，「廉价候选漏斗」会成为主流成本结构——Keystone 的 L0–L3 分层押注于此。
- **【预测】** Agent 协议会继续碎片化演进（MCP/ACP/A2A/Skills 各管一段），「在恰当边界上挂标准、内核语义自守」比「自研大一统协议」更可持续。
- **【预测】** 随着模型自主能力增强，外部硬约束层（权限租约、预算硬停、证据完成判定）的价值会**上升**而非下降。
- **【预测】** 本地优先 + BYOK + 可重放审计，会在合规/隐私敏感场景成为刚需差异化。
- **【预测】** 数字阈值（如「领先 X%」）须由公开基线评测产生，现阶段**不应预设**任何具体数字。

---

## 13. 来源 URL 清单（精确链接）

**Keystone 自身（锁定提交 `79ddf698`）**
- 仓库：https://github.com/abinzhao/keystone-harness
- 下一代架构说明：`docs/architecture/2026-10-19-keystone-next-generation-harness-architecture.md`
- 竞品分析：`docs/research/2026-10-19-agent-harness-competitive-analysis.md`
- 性能基线：`docs/performance/baseline-2026-10-19.md`
- 路线图：`ROADMAP.md`

**外部公开标准与趋势**
- Model Context Protocol (MCP)：https://modelcontextprotocol.io ；Anthropic 发布说明：https://www.anthropic.com/research/model-context-protocol
- Agent2Agent (A2A) Protocol：https://a2a-protocol.org/latest/
- Agent Client Protocol (ACP)：https://agentclientprotocol.com
- Agent Skills 开放格式：https://agentskills.io/home ；Anthropic 工程说明：https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- OpenAI Responses API（构建 Agent 的新工具，2025-03-11）：https://openai.com/index/new-tools-for-building-agents/
- Local-first Software（Ink & Switch）：https://www.inkandswitch.com/local-first-software/
- Event Sourcing（Martin Fowler）：https://martinfowler.com/eaaDev/EventSourcing.html ；Memory Image：https://martinfowler.com/bliki/MemoryImage.html
- Tauri（计划中的桌面外壳）：https://tauri.app
- 本地模型运行时：Ollama https://ollama.com ；vLLM https://docs.vllm.ai ；LM Studio https://lmstudio.ai

---

## 14. 诚信边界声明

1. 本文所有【现状】均可在锁定提交 `79ddf698` 的代码与文档中复现；【下一步】【探索】均为规划，不代表已交付。
2. **未实现但易被误述为已有的能力**：面向普通用户的桌面应用（当前仅开发者预览 / CLI 优先 + 本地回环 Web 工作台）、Tauri 打包/签名/公证/原生集成、原生 OpenAI Responses / 原生 tool-calling / Anthropic·Gemini 原生协议、Git 写操作（commit/rollback）、Windows 端到端测试、工作区扫描性能测量、MCP/Agent Skills/ACP/A2A 实际集成、可复现功效 scorecard（列为 P1 第一闸门）。
3. 模型接入现状是 **OpenAI Chat Completions 兼容文本补全**；「支持更强模型」指兼容该协议即可接入，不代表已内置各厂商原生协议。
4. 换模型保证的是**语义/契约/证据口径不变**，不是结果逐字一致。
5. **领域范围**：今天只交付软件工程垂直；个人/研究/创作/企业/设备·机器人均为**未来能力包**，不是今天已有的成品 App；机器人硬实时安全联锁须在模型之外的硬件/固件层实现，且不默认排进 P1。
6. 任何「领先/第一」表述须引用可复现实验与 scorecard，本文不预设具体数值。
7. 协议字段、事件类型、Schema 路径、证明包为英文机器格式，本文中文叙述不改变其语义。
