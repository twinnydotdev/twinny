# twinny

留在你网络内部的 Visual Studio Code AI 编程助手。代码补全、内联编辑、对话、代码审查等功能，模型服务器由你选择：本机、你的另一台设备、托管 API，或整个团队共用的一个网关。免费、开源、MIT 许可，无遥测，无需登录。

[从市场安装](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny) · [文档](https://docs.twinny.dev/zh-cn/) · [更新内容](https://docs.twinny.dev/reference/whats-new/) · [变更日志](CHANGELOG.md) · [团队](https://docs.twinny.dev/teams/overview/) · [English](README.md) · [Português (BR)](README.pt-BR.md)

## 开始使用

1. 从市场安装 twinny（需要 VS Code 1.93 或更新版本）。
2. 运行一个模型服务器。首次启动时会在常用端口上找到 Ollama、LM Studio 和 llama.cpp，并询问使用哪些模型。
3. 开始输入。补全以幽灵文本出现；侧边栏是对话。

[快速开始](https://docs.twinny.dev/zh-cn/getting-started/quick-start/)介绍如何按硬件选择服务器和模型，[故障排除](https://docs.twinny.dev/zh-cn/getting-started/troubleshooting/)解释每一条错误信息。

## 功能

- **[代码补全](https://docs.twinny.dev/zh-cn/features/code-completion/)。** 输入时的中间填充建议，以幽灵文本流式显示，在合理处停止。上下文来自打开的文件、导入、语言服务器和你最近的编辑。针对 7B 模型调优。
- **[内联编辑](https://docs.twinny.dev/zh-cn/features/inline-edit/)。** 按 Ctrl+I，描述改动，在编辑器中以差异形式审阅。按块接受或拒绝。任何诊断上都有"用 twinny 修复"。
- **[对话](https://docs.twinny.dev/zh-cn/features/chat/)。** 输入 `@` 附加文件、符号、问题面板、git 差异、终端，或工作区索引的搜索结果。对话会被保存。
- **[工作区索引](https://docs.twinny.dev/zh-cn/features/workspace-index/)。** 对工作区的关键词与向量混合搜索，进入提示词前重排，保存时更新。回复下方显示来源。
- **[代码审查](https://docs.twinny.dev/zh-cn/features/code-review/)**：审查工作树、分支相对基线的改动，或 GitHub 拉取请求；**[提交信息](https://docs.twinny.dev/zh-cn/features/commit-messages/)**由暂存的差异生成。
- **[终端](https://docs.twinny.dev/zh-cn/features/terminal/)。** 用一句描述写出命令，运行前先展示。命令失败时，twinny 找到文件和行号并给出修复。
- **[提示词模板](https://docs.twinny.dev/zh-cn/features/templates/)**可编辑，每个功能都是可重新绑定的普通 VS Code 命令。

一切都针对你控制的服务器运行。无遥测，无账户。见[状态栏、日志与隐私](https://docs.twinny.dev/zh-cn/features/status-and-logs/)。

## 模型服务器与提供商

| 模型运行在哪里 | 怎么用 |
| --- | --- |
| **本机** | [Ollama](https://docs.twinny.dev/zh-cn/providers/ollama/)、[LM Studio](https://docs.twinny.dev/zh-cn/providers/lm-studio/)、[llama.cpp](https://docs.twinny.dev/zh-cn/providers/llama-cpp/)、QVAC、Oobabooga、LiteLLM、Open WebUI，或[任何 OpenAI 兼容服务器](https://docs.twinny.dev/zh-cn/providers/other-local-servers/)。 |
| **你的另一台电脑** | [设备](https://docs.twinny.dev/zh-cn/providers/devices/)：用配对码配对，通过加密的点对点链路使用那台机器的 GPU。无账户，无中继。 |
| **托管 API** | [OpenAI、Anthropic、Mistral（Codestral 用于补全）、DeepSeek、OpenRouter、Gemini、Groq、Cohere、Perplexity](https://docs.twinny.dev/zh-cn/providers/hosted-apis/)。 |
| **团队网关** | 连接到一个 `twinny-server`，使用团队配置好的模型。见下文。 |

可以混用：本地模型做补全，托管模型做对话。[支持的模型](https://docs.twinny.dev/zh-cn/providers/supported-models/)页面说明哪些模型在哪种硬件上适合哪项工作。

## 团队：一个网关，全员共用

`twinny-server` 是一个无依赖的小型服务器，运行在有模型的机器上，向每位开发者的 VS Code 提供对话、补全和嵌入。提示词只会发往你的网关和你的后端，不去别处。

```sh
npx twinny-server quickstart
```

它会找到你的模型服务器、写好配置、生成管理员密钥并开始服务。在管理页面上设置团队默认模型，给每位开发者发一个邀请链接（打开即在 VS Code 中完成连接），并查看每人、每个模型的用量。

- **每位开发者一把密钥**，以哈希存储，可即时吊销。按人、按模型统计请求、失败和 token；从不记录内容。
- **汇聚团队自己的电脑。** 开发者打开"共享这台电脑"，其本地服务器就通过网关为团队服务。不用开放端口。
- **插件**（需许可证）：GitHub、GitLab、Gitea 和 Bitbucket 的拉取请求与议题列在管理页面上，由你自己的模型审查，审查结果可回发到托管平台；Slack、Discord 和 Teams 通知；用任意 OpenID Connect 提供商单点登录；供每位开发者对话使用的共享上下文索引；每夜备份。
- **团队策略**（需许可证）：只允许团队网关、锁定默认模型、把某个工作区限制在本地后端的路由规则、团队系统提示词。连接前先展示并征得同意。
- **请求记录**（需许可证）：把提示词和回复保存在网关上，向每位开发者披露，可导出为训练数据。
- **运维**：每次管理变更都写入哈希链式审计日志、只读管理员密钥、Prometheus 指标、模型设有价格时按开发者统计成本、共享 GPU 的请求队列、Docker 和 Helm chart。

五位开发者以内永久免费。刷卡购买的许可证增加席位并开启策略、记录和插件；在本地校验，网关从不回连。见[团队指南](https://docs.twinny.dev/teams/overview/)、[许可与席位](https://docs.twinny.dev/teams/licensing/)，以及 [docs/gateway.md](docs/gateway.md) 中的运维参考。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `src/extension` | VS Code 扩展，按功能划分：补全、对话、内联编辑、审查、终端、嵌入、提供商、团队连接。 |
| `src/webview` | 侧边栏（React）。 |
| `src/protocol` | 扩展与网关之间的线路协议，以及汇聚电脑所用的 WebSocket 对等协议。 |
| `src/gateway` | 网关：路由、密钥、用量、许可、管理页面、插件。构建为 `packages/twinny-server/cli.js`。 |
| `src/licensing` | 许可证令牌校验（签发端不公开）。 |
| `packages/twinny-server` | 网关的 npm 包和 Docker 文件。 |
| `deploy/helm` | Kubernetes 的 Helm chart。 |
| `docs` | 网关运维参考和设计笔记。 |

## 贡献

欢迎在 [GitHub](https://github.com/twinnydotdev/twinny) 提交议题和拉取请求。较大的改动请先在议题中描述。[CONTRIBUTING.md](CONTRIBUTING.md) 有构建和测试步骤；测试套件可用 `xvfb-run -a npm test` 无头运行。问题可在[讨论区](https://github.com/twinnydotdev/twinny/discussions)或 [@twinnydotdev](https://x.com/twinnydotdev) 提出。

## 支持 twinny

twinny 免费且开源。如果它对你有用，购买团队许可证是最好的支持方式。也欢迎捐赠。比特币：`1PVavNkMmBmUz8nRYdnVXiTgXrAyaxfehj`

## 许可证

MIT。twinny 正在积极开发中，按原样提供。
