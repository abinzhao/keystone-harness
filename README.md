# Keystone

**简体中文** · [English](./README.en.md)

Keystone 是一个**证据原生、本地优先的通用 Agent 基座**。

它的核心是一个极小的可信内核：在用户明确设定的边界内完成工作，并用可重放的证据——而不是模型的自我声明——证明任务已经完成。模型、工具、验证器、技能与客户端都是按需接入的受治理扩展；**工程实践是它的第一个参考垂类**。

> 一句话：稳定的内核负责「什么是真的、谁被允许做什么」，认知能力全部可插拔。

## 当前状态

**这是开发者预览版（CLI 优先）**：面向愿意从命令行驱动内核的开发者；面向普通用户的桌面外壳尚未实现。

Keystone 处于早期实现阶段。**P0 内核、运行时与无界面 CLI 已经存在**，并在真实 Git 仓库上端到端跑通：

- 证据原生的任务循环：每条必需条件都具备达到要求等级的有效证据时，任务才进入 `proven`。
- 机器可读的结果契约（Outcome Contract）、能力租约（Capability Lease）、证据记录（Evidence）与证明包（Proof Package），在 `@keystone/schemas` 中统一定义一次。
- 仅追加事件账本；重放即可复现权威任务状态。
- 检查点、可分支运行图与分支比较、恢复评估，以及工作区变化时精确的证据失效。
- 经验防火墙：未经验证的经验不进入后续任务，一旦后续任务表明它没有帮助就会被降级。
- 受治理扩展面（清单、完整性、一致性套件、注册表），并附带一个可运行参考扩展。
- 本地 Run Protocol 服务与四区工作台——与 CLI 共用同一运行时与同一套 Schema。

**尚未完成（请勿夸大）**：桌面外壳（计划中的 Tauri 薄封装）尚未构建；Git 写操作（commit / rollback）尚未实现，目前是只读 Git 工具 + `git worktree` 隔离；Windows 仅在解析层实现并通过单测，端到端套件尚未在 Windows 真机运行。里程碑与出入口门槛见 [ROADMAP.md](./ROADMAP.md)。

Keystone 采用 [Apache License 2.0](./LICENSE) 许可。

## 为什么这样设计

- **证据 > 声明**：完成判定是对结果契约与证明图的一次确定性查询；模型说「已完成」不算数。
- **本地优先**：运行时数据在 `~/.keystone/`（可用 `KEYSTONE_HOME` 覆盖），不绑定任何厂商云。
- **内核稳定，能力可插拔**：模型与扩展只能提出行动建议；只有内核能改变权威状态、签发租约、接受证据、判定完成、晋升长期经验。
- **通用基座，工程先行**：内核与协议不绑定工程语义；工程是用来压测这套基座的第一个垂类。

设计依据见 [通用基座架构](./docs/architecture/2026-10-20-keystone-universal-foundation.md)；外部趋势证据见 [未来 Agent 基座证据](./docs/research/2026-10-20-future-agent-foundation-evidence.md)。

## 基座面向的场景

内核不绑定任何垂类。**工程是第一个、也是当前唯一已交付的参考垂类**。同一个内核围绕六组共享原语设计——目标/契约、上下文/记忆、能力、策略/租约、证据/回执、异常/人工决策——从而能承载个人、研究、创作、企业、物理设备/机器人等场景包：它们都以适配器 + 扩展接入、**不改动内核**，但目前都只是设计目标，尚未实现。

面向普通用户的终态是**零配置渐进式披露**：默认隐藏机制，不可逆操作前给预览，完成后留回执，异常时暂停，运行可随时重放。当前交付的仍是**开发者面**（SDK / 协议 / 调试 / 评测）；普通用户桌面外壳尚未构建。

## 仓库结构

| 包 | 职责 |
|---|---|
| [`@keystone/schemas`](./packages/schemas) | 权威 Schema、校验器、canonical 编码与内容寻址 |
| [`@keystone/kernel`](./packages/kernel) | 账本、状态机、契约、租约、运行图、证据、证明、经验、检查点 |
| [`@keystone/tools`](./packages/tools) | 文件系统、搜索、命令执行与 git 工具（统一经过租约校验） |
| [`@keystone/verifiers`](./packages/verifiers) | test / typecheck / lint / build / scope / project_rule 验证器 |
| [`@keystone/models`](./packages/models) | BYOK 的 OpenAI 兼容适配器、确定性离线适配器、路由 |
| [`@keystone/runtime`](./packages/runtime) | 组合根：Builder 与 Assurance 双环、上下文规划、自治、本地 Run Protocol 服务 |
| [`@keystone/extensions`](./packages/extensions) | 清单校验、完整性、安装审查、一致性套件、注册表 |
| [`@keystone/i18n`](./packages/i18n) | 呈现层本地化：语言解析与 zh-CN / en 文案目录 |
| [`@keystone/cli`](./packages/cli) | 无界面客户端：项目接入、任务运行、恢复、分支、证明导出、重放 |
| [`@keystone/extension-no-debug-statements`](./packages/extension-no-debug-statements) | 参考扩展：贡献者可以照抄的验证器 |

## 快速开始

需要 Node.js `>=22.18.0`（原生 TypeScript 类型剥离）与 pnpm 8。

```bash
pnpm install          # 链接 workspace 各包
pnpm run typecheck    # tsc，无构建步骤
pnpm test             # 用 node:test 跑 packages/*/test
pnpm run verify       # typecheck + 测试
```

内核**没有运行时依赖**；各包直接从 TypeScript 源码运行，没有构建步骤。由此带来两条在代码评审中强制执行的约束：不使用无法被类型剥离抹除的语法（`enum`、`namespace`、构造函数参数属性、装饰器）；相对导入必须带显式的 `.ts` 扩展名。

## 使用 CLI

```bash
node packages/cli/src/bin.ts --help
node packages/cli/src/bin.ts project inspect .
node packages/cli/src/bin.ts task run --project . --request "fix the duplicate session refresh"
node packages/cli/src/bin.ts proof show <taskId>
node packages/cli/src/bin.ts replay <taskId>
```

### 配置模型（任意 OpenAI 兼容端点）

Keystone 通过 OpenAI Chat Completions 形状的接口通信、不依赖任何厂商 SDK，因此 OpenAI 官方、Azure 兼容网关、OpenRouter，以及本地的 Ollama / LM Studio / vLLM / llama.cpp / LocalAI 都能接入。密钥从 stdin 读入，存放在 `~/.keystone/credentials` 并请求仅属主可读权限，绝不写进配置文件。

> **今天的模型能力边界**：仅支持经 OpenAI 兼容 Chat Completions 接口的**文本补全**。原生 Responses API、原生函数 / 工具调用协议、Anthropic Messages 与 Gemini 原生端点均**不是当前能力**，属于后续规划。模型在这一接口内只产出行动建议与观察；不依赖厂商专属能力即可工作，正是本地优先的目的。

```bash
# 托管、OpenAI 兼容端点（BYOK）
node packages/cli/src/bin.ts model add --id cloud-main --kind cloud \
  --provider openai-compatible --model gpt-x \
  --base-url https://api.openai.com/v1 --endpoint-host api.openai.com \
  --credential-handle main
node packages/cli/src/bin.ts model credential set main   # 在 stdin 粘贴密钥

# 本地端点（Ollama 示例）：无需凭据，数据不出本机
node packages/cli/src/bin.ts model add --id local-ollama --kind local \
  --provider ollama --model llama3.1 \
  --base-url http://127.0.0.1:11434/v1 --endpoint-host 127.0.0.1

node packages/cli/src/bin.ts model route builder cloud-main
node packages/cli/src/bin.ts doctor
```

离线运行与评测可使用确定性 scripted 模型（`--scripted-fixture <file.json>`）；它不是智能体，会如实报告零 token 消耗，而不是给出估算。

## 工作台

运行时通过 Keystone Run Protocol 把自己提供给一个外壳：

```bash
node packages/cli/src/bin.ts serve --port 7801
```

它只监听回环地址并打印一个 bearer token。运行模式可按任务、按服务选择：`minimal`（仅确定性检查，不使用模型）、`standard`、`isolated`（独立 Git worktree，工作副本不被触碰）与 `replay`。

```bash
node packages/cli/src/bin.ts protocol export --out ./protocol   # 每个对象的 JSON Schema
pnpm run bench                                                  # 性能基线测量脚本
```

## 架构承诺

- 完成判定是对结果契约与证明图的一次确定性查询。
- 每一个副作用都需要一份有范围、短时效的能力租约。
- 上下文、记忆、证据与派生状态都保留来源与失效规则。
- 长期经验必须经过经验防火墙的隔离、评估、晋升与降级。
- 自治程度只能在用户设定的硬边界内提升或衰减。
- 内核保持稳定；模型、工具、工作区、分析器、验证器、Skill、客户端与协议适配器都是受治理扩展。
- Minimal Runtime 始终可用于评测、诊断与安全降级。

## 文档

- [产品需求文档](./需求文档.md)（中文）
- [下一代产品战略（2026-10-20）](./docs/product/2026-10-20-keystone-next-generation-product-strategy.md)
- [产品战略报告 · HTML（2026-10-20）](./docs/product/2026-10-20-keystone-next-generation-report.html)
- [通用基座架构（2026-10-20）](./docs/architecture/2026-10-20-keystone-universal-foundation.md)
- [未来 Agent 基座证据（2026-10-20）](./docs/research/2026-10-20-future-agent-foundation-evidence.md)
- [竞品分析（2026-10-19）](./docs/research/2026-10-19-agent-harness-competitive-analysis.md)
- [路线图](./ROADMAP.md)
- [贡献指南](./CONTRIBUTING.md) · [治理](./GOVERNANCE.md) · [安全策略](./SECURITY.md) · [支持](./SUPPORT.md)

### 架构决策记录

- [ADR-0001：证据原生双环](./docs/adr/0001-evidence-native-dual-loop.md)
- [ADR-0002：内核是唯一状态权威](./docs/adr/0002-kernel-is-sole-state-authority.md)
- [ADR-0003：事件溯源的任务账本](./docs/adr/0003-event-sourced-task-ledger.md)
- [ADR-0004：TypeScript 与零运行时依赖](./docs/adr/0004-typescript-zero-runtime-dependencies.md)
- [ADR-0005：本地优先的存储布局](./docs/adr/0005-local-first-storage-layout.md)

---

Keystone 以 Apache-2.0 许可发布。语言只影响人读到的文案；协议字段名、事件类型、Schema 校验路径与证明包都是与语言无关的机器格式——证明包尤其内容寻址，无论以哪种语言展示都必须字节一致。
