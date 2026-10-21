# M0–M3 首批验收

日期：2026-10-21。分支：`feat/workbench-m0-m3`。版本继续为 `1.0.0-rc.1`，Run Protocol 为 `1.3.0`。本次交付仅覆盖已批准的首批；完整 PRD 的后续 M4–M8 保持开放。

## 已交付

| 范围 | 实际行为 | 验证入口 |
|---|---|---|
| M0 可信执行 | 外来任务/分支/Contract/版本证据拒收；不完整观察不可证明；旧通过不能覆盖新失败；验证后再次观测；暂停/停止后不发新租约 | kernel proof/kernel/ledger，runtime execution-boundary，CLI proof |
| M0 执行记录 | 租约绑定规范参数哈希，动作提案和实际执行可追溯；模型按每次真实调用记 usage/时间；fallback 动作归属实际模型 | tools、router-hooks、workbench-api、execution-boundary |
| M0 扩展检查 | 静态审阅不导入未知入口；有界探针需用户决定和内容 review hash；参考扩展 conformance 保持可用 | extensions 和 CLI extension tests |
| M1 工作台 | 模块化 DOM/ESM，项目/自然任务名导航，概览/轨迹/文件/Diff/命令与证明面板；请求取消与版本保护；主题/密度/语言/键盘面板 | workbench-client/page，真实 Chromium 旅程 |
| M2 项目与文件 | 独立登记、命名/置顶/归档/移除/重连；真实根目录/分支/dirty/扫描/任务投影；受限树/搜索/读取；哈希冲突、创建/编辑/改名/删除/补偿撤销 | projects/files/file-workbench-api |
| M2 设置与凭据 | 乐观配置保存，活动模型快照不变，新任务采用新路由/预算；独立探测/生成；macOS Keychain broker、非秘密 namespace、显式 legacy 迁移 | models/desktop/config、settings-live-api |
| M2 数据与命令 | 分类占用/导出、清理影响预览与引用/活动/冻结保护；复制、哈希校验后切换全部 store，源保留；原生配置桥同步切换；人类命令独立租约/输出/退出码/范围回执 | data-management、settings-live-api、desktop data-switch、commands-api |
| M3 输入 | PNG/JPEG/WebP 与 UTF-8 文本，原始内容寻址工件、元数据/来源与草稿；四种协议 typed parts；大小/数量/MIME 拒绝；预算化文本摘录；云出站单独确认 | attachments、multimodal、settings-live-api、transport-boundary |

## 浏览器与原生证据

使用真实临时 Git 仓库和独立数据根，无真实账号、用户项目或密钥。

- Chromium：项目登记 → 设置/深浅主题 → 文件读取/编辑/撤销 → 执行实际缺陷修复并 `proven` → 统一/双栏 Diff → 图片与文本上传 → 附件任务历史 → 独立命令确认/输出 → 数据占用与缓存预览/清理。
- 1280、900、375px 无整页横向溢出；导航/证明抽屉、Cmd+K 和 Escape 可用。200% CSS 缩放在 640px 有效视口经过尺寸观测并修复导航溢出；未把它等同为所有浏览器真实页面缩放的验证。
- 文件哈希冲突、快速乱序选择、暂停/停止、数据保护、cloud consent 取消保留草稿由确定性 client/API 回归覆盖；未宣称浏览器已逐个操作所有异常状态。
- macOS：系统 Swift 编译 AppKit/WebKit/Security helper，真实菜单/面板对象自检 6 项通过；凭据注入内存后端 5 项通过。`.app` 启动成功，取得独立窗口截图确认 WKWebView 渲染。未通过自动化逐个点击原生菜单或权限提示。

截图：[1280 深色](./workbench-1280-dark.png)、[900 深色](./workbench-900-dark.png)、[375 深色](./workbench-375-dark.png)、[浅色附件历史](./workbench-1280-light-input.png)、[命令回执](./workbench-command-receipt.png)、[原生窗口](./workbench-native-window.png)。

## 验证与限制

`pnpm run verify` 执行根类型检查和全部测试，固定最多四个测试文件并行，避免 Swift 构建/探针/任务检查争用导致超时。未改变保护断言或把未知检查当通过。最终计数以 execution.md 的最后记录为准。

`node packages/desktop/scripts/build-native.ts --out /tmp/keystone-native-final-build`、helper `--self-test` 和独立 `.app` 启动已执行。`git diff --check` 通过。未提交、推送、合并或发布，未新增生产运行依赖。

未验证/后续事项：

1. 商业模型账号上的文本/图片实测、账单价格、真实 Keychain 授权提示；fixture HTTP 请求能验证协议和字节，不能替代线上模型能力。
2. 独立模型代码审查未完成：审查进程配置的本地模型端点不可连接。已完成主执行者最终 Diff/范围/拒绝路径检查，不能标为独立审查通过。
3. 应用级范围观测不提供 OS 文件或网络 sandbox。命令能在进程结束后报告仓库越界；不承诺阻止任意子进程在外部写入。命令确认页明确显示此边界。
4. PTY、audio/video/PDF 理解、完整插件中心/MCP/ACP/A2A、符号/增量认知、高级恢复/反事实证明、自动保留期清理、签名公证/安装分发均属于后续路线。
5. 真实拖放/剪贴板截图、浏览器原生 200% zoom、键盘全组合和所有原生 GUI 状态尚未穷尽；已实现输入处理器并有客户端/协议测试。

## 最终审阅处置

在范围对账中确认并修复：独立命令 API 缺失、macOS 路径别名投影误判、等价目录修订误触发范围扩大、默认预算未生效、fallback 提案归属错误、CLI 当前证明缺少 workspace fingerprint、原生迁移后配置桥仍指向源、语言切换标签未刷新。每项保持 KernelSession 权威入口和用户原有修改边界。

`.gitignore` 和 `.keystone-native-rc-audit/` 为原有用户改动，未由本批次改写。ADR 在当前用户 ignore 规则下仍被忽略；发布该分支前需将 ADR 按项目文档流程纳入版本控制，不能遗漏不变量依据。
