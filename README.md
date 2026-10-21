# Keystone

**简体中文** · [English](./README.en.md)

Keystone 是一个**证据原生、本地优先的通用 Agent 基座**。

它的核心是一个极小的可信内核：在用户明确设定的边界内完成工作，并用可重放的证据——而不是模型的自我声明——证明任务已经完成。模型、工具、验证器、技能与客户端都是按需接入的受治理扩展；**工程实践是它的第一个参考垂类**。

> 一句话：稳定的内核负责「什么是真的、谁被允许做什么」，认知能力全部可插拔。

## 当前状态

**这是开发者预览版（CLI 优先）**：当前工作树即 `1.0.0-rc.1` 候选——整个 workspace 已一致标记为预发布候选版本，但它**不是**稳定 1.0.0：根包保持 `private`，不发布到任何 registry，不签名、不公证；正式 1.0.0 仍需 ROADMAP 验收门槛关闭后由 `--allow-1.0` 显式准入（见 [ADR-0012](./docs/adr/0012-release-candidate-boundary.md)）。除 CLI 外，本 RC 还包含一个实验性的 macOS 原生窗口薄壳；它复用同一 Run Protocol，不是第二套运行时，但尚未打包、签名或公证为可分发 `.app`。

Keystone 处于早期实现阶段。**P0 内核、运行时与无界面 CLI 已经存在**，并在真实 Git 仓库上端到端跑通：

- 证据原生的任务循环：每条必需条件都具备达到要求等级的有效证据时，任务才进入 `proven`。
- 机器可读的结果契约（Outcome Contract）、能力租约（Capability Lease）、证据记录（Evidence）与证明包（Proof Package），在 `@keystone/schemas` 中统一定义一次。
- 仅追加事件账本；重放即可复现权威任务状态。
- 检查点、可分支运行图与分支比较、恢复评估，以及工作区变化时精确的证据失效。
- 经验防火墙：未经验证的经验不进入后续任务，一旦后续任务表明它没有帮助就会被降级。
- 受治理扩展面（清单、完整性、一致性套件、注册表），并附带一个可运行参考扩展。
- 受治理的本地进程外能力：经既有扩展流接入的本地 `stdio` MCP 工具，以及按磁盘目录发现的项目/用户 Agent Skills——二者均作为非受信输入、不凭存在即获得权限、无远程传输或市场（ADR-0009）。
- 本地 Run Protocol 服务与四区工作台——与 CLI 共用同一运行时与同一套 Schema。

**尚未完成（请勿夸大）**：桌面薄壳已在 macOS 上使用 Swift + WKWebView 原生窗口承载同源回环代理；它监督 `keystone serve` 子进程、服务端注入 bearer token、以 nonce 保护 `/desktop/*`，并提供首启 BYOK、简单/高级模式、风险分级 Contract 预览及终态回执（ADR-0008、ADR-0013）。当前原生 helper 已在 Apple M3 Pro 上从源码构建并做本地入口验证，但**没有**通用 `.app` 打包、Intel/universal 构建、Apple Developer ID 签名或公证；非 macOS 或未构建 helper 时会明确降级到系统浏览器。Git 写操作已实现：`git.commit` / `git.rollback` 在带范围、短时效的 `git.write` 能力租约内运行；接入时已有用户修改与目标写路径重叠会拒绝启动并提示 commit/stash/isolated 恢复（ADR-0007、ADR-0013）。Windows 仅在解析层实现并通过单测，端到端套件尚未在 Windows 真机运行。

Keystone 采用 [Apache License 2.0](./LICENSE) 许可。

## 为什么这样设计

- **证据 > 声明**：完成判定是对结果契约与证明图的一次确定性查询；模型说「已完成」不算数。
- **本地优先**：运行时数据在 `~/.keystone/`（可用 `KEYSTONE_HOME` 覆盖），不绑定任何厂商云。
- **内核稳定，能力可插拔**：模型与扩展只能提出行动建议；只有内核能改变权威状态、签发租约、接受证据、判定完成、晋升长期经验。
- **通用基座，工程先行**：内核与协议不绑定工程语义；工程是用来压测这套基座的第一个垂类。

设计依据见 [通用基座架构](./docs/architecture/2026-10-20-keystone-universal-foundation.md)；外部趋势证据见 [未来 Agent 基座证据](./docs/research/2026-10-20-future-agent-foundation-evidence.md)。

## 基座面向的场景

内核不绑定任何垂类。**工程是第一个、也是当前唯一已交付的参考垂类**。同一个内核围绕六组共享原语设计——目标/契约、上下文/记忆、能力、策略/租约、证据/回执、异常/人工决策——从而能承载个人、研究、创作、企业、物理设备/机器人等场景包：它们都以适配器 + 扩展接入、**不改动内核**，但目前都只是设计目标，尚未实现。

面向普通用户的终态是**零配置渐进式披露**：默认隐藏机制，低风险且范围明确、可逆、无外部写的写任务在预览后可按项目策略自动开始；歧义、越界、不可逆/外部动作、高风险或策略要求仍需确认；完成后留回执，异常时暂停，运行可随时重放。当前 RC 的 macOS 原生窗口与 BYOK 向导已经覆盖这条主路径，但仍是未签名、未公证、未打包分发的开发者预览。

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
pnpm run release:all  # 离线 SBOM + build-info + 版本/发布就绪检查（不发布、不签名）
```

CI 在 macOS / Linux 上跑 install / typecheck / test，并生成离线 SBOM 与 build-info；另有一条非阻塞的 Windows 验证路径（尚未在 Windows 真机确认）。发布产物只写到 git 忽略的 `dist/release/`；当前版本为预发布候选 `1.0.0-rc.1`，版本统一只能通过 `pnpm run release:bump <version>` 权威脚本完成，生成物与锁文件一律由对应生成器/`pnpm install` 重生成，从不手改；任何脚本都不会自动发布、签名或公证。

内核**没有运行时依赖**；各包直接从 TypeScript 源码运行，没有构建步骤。由此带来两条在代码评审中强制执行的约束：不使用无法被类型剥离抹除的语法（`enum`、`namespace`、构造函数参数属性、装饰器）；相对导入必须带显式的 `.ts` 扩展名。

## 使用 CLI

```bash
node packages/cli/src/bin.ts --help
node packages/cli/src/bin.ts project inspect .
node packages/cli/src/bin.ts task run --project . --request "fix the duplicate session refresh"
node packages/cli/src/bin.ts ci --project . --request "fix the duplicate session refresh" --scripted-fixture fixture.json
node packages/cli/src/bin.ts proof show <taskId>
node packages/cli/src/bin.ts replay <taskId>
node packages/cli/src/bin.ts extension install ./packages/extension-no-debug-statements
node packages/cli/src/bin.ts extension list
```

扩展由用户治理：`extension install <本地路径>` 先校验清单摘要与实际入口字节、跑一致性套件、再用自然语言展示它能做什么、数据是否出站、是否可逆；能触网或不可逆的扩展需要显式 `--yes` 才会被记录，激活时再经一次门禁。没有远程市场——只从本地目录安装。

无人值守（CI）请用 `keystone ci`：它永不交互、在标准输出打印一份稳定 JSON（含脱敏 proof 产物路径），并用与 `task run` 一致的退出码表达结果——`0` 已证明、`3` 需人工介入（非失败）、`1` 未证明、`2` 用法错误。详见 [docs/architecture/cli-automation-surface.md](./docs/architecture/cli-automation-surface.md)。

### 配置模型（BYOK）

Keystone 不依赖任何厂商 SDK，直接以平台 `fetch` 与各厂商的原生 HTTP 接口通信。密钥从 stdin 读入，存放在 `~/.keystone/credentials` 并请求仅属主可读权限，绝不写进配置文件。

支持四种线路协议（见 [ADR-0010](./docs/adr/0010-native-model-capability-negotiation.md)）：

| `--protocol` | 线路 | 原生工具调用 | 结构化输出 |
|---|---|---|---|
| `openai-chat`（默认） | OpenAI 兼容 Chat Completions | 否（文本信封） | 是 |
| `openai-responses` | OpenAI Responses | 是 | 是 |
| `anthropic-messages` | Anthropic Messages | 是 | 否（JSON 由调用方校验） |
| `gemini-generate` | Gemini GenerateContent | 是 | 是 |

> **能力即契约**：描述符只声明适配器真正实现的能力。请求携带工具描述时，路由只会选择声明了原生工具调用的适配器；若路由上没有任何模型满足，会在发网前明确报错，而不是悄悄丢弃工具描述。流式与多模态在 v1 一律声明为未实现。旧配置（无 `protocol` 字段）仍可读取，默认按 `openai-chat` 处理。原生线路的请求/响应/工具调用映射与能力路由均已实现，并用进程内 mock `fetch` 单测覆盖；但 v1 的 Builder Loop 仍走校验过的文本信封（传 `tools: []`），且尚未对任何真实厂商接口做联调验证。

```bash
# 托管、OpenAI 兼容端点（BYOK）
node packages/cli/src/bin.ts model add --id cloud-main --kind cloud \
  --provider openai-compatible --model gpt-x \
  --base-url https://api.openai.com/v1 --endpoint-host api.openai.com \
  --credential-handle main
node packages/cli/src/bin.ts model credential set main   # 在 stdin 粘贴密钥

# 原生厂商线路：--protocol 会自动填入默认 base-url 与 host
node packages/cli/src/bin.ts model add --id anth --kind cloud \
  --provider anthropic --model claude-x --protocol anthropic-messages \
  --credential-handle main

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
- [ADR-0006：工程词法抽到场景包](./docs/adr/0006-engineering-scenario-pack-extraction.md)
- [ADR-0007：带范围的 Git 提交生命周期](./docs/adr/0007-scoped-git-commit-lifecycle.md)
- [ADR-0008：桌面壳与合同确认](./docs/adr/0008-desktop-shell-and-contract-confirmation.md)
- [ADR-0009：受治理的本地 MCP 与 Skills](./docs/adr/0009-governed-local-mcp-and-skills.md)
- [ADR-0010：原生模型能力协商](./docs/adr/0010-native-model-capability-negotiation.md)
- [ADR-0011：ACP 映射与 stdio 适配器（已阻塞，未实现适配器）](./docs/adr/0011-acp-mapping-and-adapter-blocker.md)
- [ADR-0012：RC 版本边界与双通道发布就绪门禁](./docs/adr/0012-release-candidate-boundary.md)
- [ADR-0013：风险分级启动与 dirty-overlap 拒绝](./docs/adr/0013-risk-graded-startup-and-dirty-overlap.md)

---

Keystone 以 Apache-2.0 许可发布。语言只影响人读到的文案；协议字段名、事件类型、Schema 校验路径与证明包都是与语言无关的机器格式——证明包尤其内容寻址，无论以哪种语言展示都必须字节一致。
