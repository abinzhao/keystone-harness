# Keystone

**简体中文** · [English](./README.en.md)

Keystone 是一款**证据原生、本地优先的工程 Agent Harness**。

它持续理解一个软件项目，在用户明确设定的边界内执行复杂工程任务，并用可重放的证据——而不是模型的自我声明——证明任务已经完成。

## 当前状态

Keystone 处于早期实现阶段。P0 内核、运行时与无界面 CLI 已经存在，并在真实 Git 仓库上端到端跑通：

- 证据原生的任务循环：只有当每一条必需条件都具备达到要求等级的有效证据时，任务才会进入 `proven`。
- 机器可读的结果契约（Outcome Contract）、能力租约（Capability Lease）、证据记录（Evidence）与证明包（Proof Package），全部在 `@keystone/schemas` 中统一定义一次。
- 仅追加的事件账本，重放即可复现权威任务状态。
- 检查点、可分支的运行图与分支比较、恢复评估，以及工作区变化时精确的证据失效。
- 经验防火墙（Experience Firewall）：未经验证的经验不会进入后续任务，一旦后续任务表明它没有帮助就会被降级。
- 受治理的扩展面（清单、完整性、一致性套件、注册表），并附带一个可运行的参考扩展。
- 本地 Run Protocol 服务与四区工作台——与 CLI 使用同一套运行时与同一套 Schema，因此桌面外壳有明确的对接缝。

桌面外壳本身尚未构建；计划中的 Tauri 只是对已有工作台的薄封装。里程碑状态见 [ROADMAP.md](./ROADMAP.md)。

Keystone 采用 [Apache License 2.0](./LICENSE) 许可。

## 仓库结构

| 包 | 职责 |
|---|---|
| [`@keystone/schemas`](./packages/schemas) | 权威 Schema、校验器、canonical 编码与内容寻址 |
| [`@keystone/kernel`](./packages/kernel) | 账本、状态机、契约、租约、证据、证明、经验、检查点 |
| [`@keystone/tools`](./packages/tools) | 文件系统、搜索、命令执行与 git 工具（统一经过租约校验） |
| [`@keystone/verifiers`](./packages/verifiers) | test / typecheck / lint / build / scope / project_rule 验证器 |
| [`@keystone/models`](./packages/models) | BYOK 的 OpenAI 兼容适配器、确定性离线适配器、路由 |
| [`@keystone/runtime`](./packages/runtime) | 组合根：Builder 与 Assurance 双环、上下文规划、自治、本地 Run Protocol 服务 |
| [`@keystone/extensions`](./packages/extensions) | 清单校验、完整性、安装审查、一致性套件、注册表 |
| [`@keystone/i18n`](./packages/i18n) | 呈现层本地化：语言解析与 zh-CN / en 文案目录 |
| [`@keystone/cli`](./packages/cli) | 无界面客户端：项目接入、任务运行、恢复、分支、证明导出、重放 |
| [`@keystone/extension-no-debug-statements`](./packages/extension-no-debug-statements) | 参考扩展：贡献者可以照抄的验证器 |

## 核心方向

Keystone 采用证据原生的双环架构：

- **Builder Loop** 负责理解、规划、编辑与执行。
- **Assurance Loop** 负责结果、上下文、能力、验证、完成判定、学习与自治。

两个环都写入一张可分叉的运行图。模型与扩展只能提出行动建议；只有稳定的内核才能改变权威任务状态、签发能力租约、接受证据、判定完成，或晋升长期经验。

## 平台支持

Keystone 支持 **macOS 与 Windows**（以及一般 POSIX 环境）；除 Node.js 与 Git 外没有平台专属的运行时依赖。

- 在 POSIX 上，命令执行从不经过 shell。在 Windows 上，包管理器启动器（`npm`、`pnpm`、`yarn`、`npx`）是 `.cmd` 脚本，无法被直接 spawn，因此会通过 `cmd.exe` 运行，并为它转义所有参数；原生可执行文件仍然直接启动。超时后进程组会在 POSIX 上被整体终止，在 Windows 上只终止直接子进程——这是已知限制。
- 临时文件使用平台临时目录（`TMPDIR` / `TEMP` / `TMP`）；凭据文件会尽力请求仅属主可读的权限（Windows 上只支持只读位）。
- **macOS 已在真机验证。Windows 支持已在解析层实现并通过单元测试，但端到端测试套件尚未在 Windows 机器上运行；请把 Windows 视为预览状态。**

## 语言

Keystone 支持**简体中文（默认）与英文**。语言只影响人读到的文本——CLI 输出、帮助摘要、工作台界面与错误信息。协议字段名、事件类型、Schema 校验路径与证明包都是与语言无关的机器格式，保持英文；证明包尤其是内容寻址的产物，无论以哪种语言展示都必须字节一致。

按以下优先级选择语言：

```bash
node packages/cli/src/bin.ts task list --lang en           # 单次调用
KEYSTONE_LANG=en node packages/cli/src/bin.ts task list    # 单个环境
```

或在 `~/.keystone/config.json` 中设置 `"language": "en"`。

## 文档

- [产品需求文档](./需求文档.md)（中文）
- [竞品分析](./docs/research/2026-10-19-agent-harness-competitive-analysis.md)
- [下一代架构](./docs/architecture/2026-10-19-keystone-next-generation-harness-architecture.md)
- [路线图](./ROADMAP.md)
- [贡献指南](./CONTRIBUTING.md)
- [治理](./GOVERNANCE.md)
- [安全策略](./SECURITY.md)
- [历史竞品设计稿](./docs/superpowers/specs/2026-10-19-keystone-competitive-product-design.md)

### 架构决策记录

- [ADR-0001：证据原生双环](./docs/adr/0001-evidence-native-dual-loop.md)
- [ADR-0002：内核是唯一状态权威](./docs/adr/0002-kernel-is-sole-state-authority.md)
- [ADR-0003：事件溯源的任务账本](./docs/adr/0003-event-sourced-task-ledger.md)
- [ADR-0004：TypeScript 与零运行时依赖](./docs/adr/0004-typescript-zero-runtime-dependencies.md)
- [ADR-0005：本地优先的存储布局](./docs/adr/0005-local-first-storage-layout.md)

## 开发

需要 Node.js `>=22.18.0`（原生 TypeScript 类型剥离）与 pnpm 8。

```bash
pnpm install          # 链接 workspace 各包
pnpm run typecheck    # tsc，无构建步骤
pnpm test             # 用 node:test 跑 packages/*/test
pnpm run verify       # typecheck + 测试
```

内核**没有运行时依赖**。各包直接从 TypeScript 源码运行，没有构建步骤。由此带来两条在代码评审中强制执行的约束：

- 不使用无法被类型剥离抹除的语法（`enum`、`namespace`、构造函数参数属性、装饰器）。
- 相对导入必须带显式的 `.ts` 扩展名。

运行时数据位于任何被管理的仓库之外，存放在 `~/.keystone/` 下（可用 `KEYSTONE_HOME` 覆盖）。见 [ADR-0005](./docs/adr/0005-local-first-storage-layout.md)。

## 使用 CLI

```bash
node packages/cli/src/bin.ts --help
node packages/cli/src/bin.ts project inspect .
node packages/cli/src/bin.ts task run --project . --request "fix the duplicate session refresh"
node packages/cli/src/bin.ts proof show <taskId>
node packages/cli/src/bin.ts replay <taskId>
```

（`pnpm run keystone <args>` 会转发同样的参数，但在 pnpm 8 下裸 `--` 之后的不转发。）

把 `KEYSTONE_HOME` 指向别处，可以让运行时数据不落在 `~/.keystone`。

### 配置模型（任意 OpenAI 兼容端点）

Keystone 通过 **OpenAI Chat Completions API**（`POST {baseUrl}/chat/completions`）与模型通信，不依赖任何厂商 SDK，因此凡是支持该格式的服务都能接入：OpenAI 官方 API、Azure OpenAI 兼容网关、OpenRouter，以及本地运行的 **Ollama、LM Studio、vLLM、llama.cpp、LocalAI** 等。云端端点为 `--kind cloud`，需要凭据；自托管端点为 `--kind local`，通常无需凭据。

密钥从 stdin 读入，存放在 `~/.keystone/credentials` 下并请求仅属主可读权限，绝不写入配置文件。

```bash
# 托管、OpenAI 兼容的端点（BYOK）
node packages/cli/src/bin.ts model add --id cloud-main --kind cloud \
  --provider openai-compatible --model gpt-x \
  --base-url https://api.openai.com/v1 --endpoint-host api.openai.com \
  --credential-handle main
node packages/cli/src/bin.ts model credential set main   # 在 stdin 粘贴密钥

# 本地端点（Ollama 示例）：无需凭据，数据不出本机
node packages/cli/src/bin.ts model add --id local-ollama --kind local \
  --provider ollama --model llama3.1 \
  --base-url http://127.0.0.1:11434/v1 --endpoint-host 127.0.0.1

# LM Studio 默认 http://127.0.0.1:1234/v1，vLLM 默认 http://127.0.0.1:8000/v1。

node packages/cli/src/bin.ts model route builder cloud-main
node packages/cli/src/bin.ts doctor
```

离线运行与评测可使用确定性的 scripted 模型（`--scripted-fixture <file.json>`）；它不是智能体，会如实报告零 token 消耗，而不是给出估算。

有两件事值得直接检查，因为它们是这个项目的意义所在：模型声称「已完成」不会让任务完成；只有每一条必需条件都带有有效证据时，任务才会 `proven`——见 `packages/runtime/test/acceptance.test.ts`。

## 工作台

运行时可以通过 Keystone Run Protocol 把自己提供给一个外壳：

```bash
node packages/cli/src/bin.ts serve --port 7801
```

它只监听回环地址，并打印一个 bearer token；打开打印出的 URL 即可，该 URL 把 token 放在 fragment 中（浏览器不会把 fragment 发送给服务器）。这个页面是真正的四区工作台——任务列表、目标与完成条件、证明与证据，以及回答人工介入的地方——没有构建步骤、没有依赖，因为桌面外壳要封装的就是它。工作台同样已本地化：服务端按解析出的语言注入文案目录，因此 `--lang en` 会得到英文界面。

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:7801/v1/capabilities
curl -H "Authorization: Bearer <token>" http://127.0.0.1:7801/v1/tasks
```

运行模式可按任务、按服务选择：`minimal`（仅确定性检查，不使用模型）、`standard`、`isolated`（独立 Git worktree，工作副本不被触碰）与 `replay`。协议导出与校验使用同一权威来源：

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
- 内核保持稳定；模型、工具、工作区、分析器、验证器、Skill、客户端与协议适配器都是受治理的扩展。
- Minimal Runtime 始终可用于评测、诊断与安全降级。

## 互操作方向

Keystone 会在各自恰当的边界上使用现有标准：

- Open Responses：模型供应商互操作。
- MCP：工具与外部资源。
- ACP：IDE 与 Agent 客户端集成。
- Agent Skills：可复用的能力包。
- A2A：未来的远端 Agent 协作。
- Keystone Run Protocol：结果契约、能力租约、来源、证据、证明、检查点与人工介入。

## 开源就绪

在对外开放贡献之前，项目将补齐：

- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `GOVERNANCE.md`
- `SUPPORT.md`
- `ROADMAP.md`
- `CHANGELOG.md`
- `AGENTS.md`

扩展 SDK、Schema、一致性套件、迁移规则、威胁模型、架构决策与发布评分卡将长期保持公开。
