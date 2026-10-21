# Keystone

**简体中文** · [English](./README.en.md)

Keystone 是一个本地优先的工程 Agent 运行时。它把任务目标、权限、执行、验证和结果证明分开：模型提出操作，内核约束边界，验证结果决定任务是否完成。

## 当前状态

仓库当前版本为 `1.0.0-rc.1`，面向希望研究或集成 Agent 运行时的开发者。

- 内核、运行时、CLI、本地 Run Protocol 和 Web 工作台已经实现。
- macOS 原生窗口可以从源码构建，但尚无签名、公证或通用架构安装包。
- 根包及所有 workspace 包均为 `private`，不会发布到 npm。
- macOS 是当前主要验证平台；CI 同时覆盖 Linux。Windows 有非阻塞验证任务，但尚未完成真机端到端验证。

这仍是候选版本，不适合作为无人值守的生产执行器。

## 设计要点

- **结果由证据决定。** 任务只有在每项完成条件都取得有效证据后才会进入 `proven`。
- **副作用受能力租约约束。** 文件、命令、Git 和网络操作必须匹配范围明确、有效期有限的 Capability Lease。
- **状态可以重放。** 权威状态来自仅追加事件账本，而不是模型输出或客户端缓存。
- **来源随数据传播。** 上下文、观察、证据和经验保留来源、信任级别与失效条件。
- **扩展不能自行提权。** 模型、工具、验证器和 Skills 可以增加能力，但不能替代内核的权限与完成判定。

完整边界见[架构概览](./docs/architecture/overview.md)。

## 快速开始

需要 Node.js `>=22.18.0` 和 pnpm `8.15.9`。

```bash
pnpm install
pnpm run verify
node packages/cli/src/bin.ts doctor
node packages/cli/src/bin.ts project inspect .
```

代码直接从 TypeScript 源文件运行，不需要构建或转译。

### 配置模型

Keystone 使用自带密钥（BYOK）。凭据从标准输入读取，保存在 `~/.keystone/credentials`，不会写入项目配置。

```bash
node packages/cli/src/bin.ts model add \
  --id local-ollama \
  --kind local \
  --provider ollama \
  --model llama3.1 \
  --base-url http://127.0.0.1:11434/v1 \
  --endpoint-host 127.0.0.1

node packages/cli/src/bin.ts model route builder local-ollama
```

云端模型支持 OpenAI-compatible Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini GenerateContent 协议。原生供应商协议会补全默认端点；自定义兼容端点需要显式配置地址、主机和凭据句柄。

### 运行任务

```bash
node packages/cli/src/bin.ts task run \
  --project . \
  --request "修复重复刷新会话的问题"
```

无人值守任务使用 `keystone ci`。它只向标准输出写入一份稳定 JSON，并用退出码区分已证明、需要人工处理、未证明和用法错误：

```bash
node packages/cli/src/bin.ts ci \
  --project . \
  --request "修复重复刷新会话的问题" \
  --scripted-fixture ./fixture.json
```

详细契约见 [CLI 自动化接口](./docs/architecture/cli-automation-surface.md)。

### 启动本地工作台

```bash
node packages/cli/src/bin.ts serve --port 7801
```

服务只监听回环地址，并在启动时输出访问令牌。

## Workspace

| 包 | 职责 |
|---|---|
| `@keystone/schemas` | 权威 Schema、运行时校验、规范编码与内容寻址 |
| `@keystone/kernel` | 事件账本、状态机、契约、租约、证据、证明与经验 |
| `@keystone/spawn` | 跨平台子进程启动兼容层 |
| `@keystone/tools` | 文件系统、搜索、命令和 Git 工具 |
| `@keystone/verifiers` | test、typecheck、lint、build、scope 和 project-rule 验证器 |
| `@keystone/models` | BYOK 模型适配器与路由 |
| `@keystone/extensions` | 扩展清单、完整性检查、注册表和一致性测试 |
| `@keystone/pack-engineering` | 工程场景的项目分析、契约提议和能力映射 |
| `@keystone/i18n` | CLI 与工作台的中英文呈现文案 |
| `@keystone/runtime` | Builder/Assurance 循环、上下文、自治、干预和本地服务 |
| `@keystone/cli` | 项目、任务、证明、重放、模型和扩展命令 |
| `@keystone/desktop` | 受监督的 macOS WKWebView 薄壳 |

两个参考扩展位于 `packages/extension-*`。

## 已知限制

- 目前只有工程场景包；内核的通用扩展边界不等于其他领域已经可用。
- 原生模型协议通过进程内 mock `fetch` 测试，尚未完成真实供应商端到端验证。
- Windows 仅覆盖进程解析等单元测试，端到端行为仍待验证。
- macOS 窗口是源码级预览，不是可分发应用。
- ACP 适配仍处于阻塞状态；当前没有 ACP adapter。

进度和准入条件见[路线图](./ROADMAP.md)。

## 文档与贡献

- [文档索引](./docs/README.md)
- [贡献指南](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)
- [支持渠道](./SUPPORT.md)
- [治理方式](./GOVERNANCE.md)
- [变更记录](./CHANGELOG.md)

提交贡献前请先运行：

```bash
pnpm run verify
pnpm run release:check
```

## 许可证

[Apache License 2.0](./LICENSE)
