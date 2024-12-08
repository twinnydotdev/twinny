# twinny
VScode的免费私有AI插件

- [Ollama](https://github.com/jmorganca/ollama)
- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [oobabooga/text-generation-webui](https://github.com/oobabooga/text-generation-webui)
- [LM Studio](https://github.com/lmstudio-ai)
- [LiteLLM](https://github.com/BerriAI/litellm)
- [Open WebUI](https://github.com/open-webui/open-webui)

## 🚀 开始使用
访问[quick start guide](https://twinnydotdev.github.io/twinny-docs/zh-cn/general/quick-start/)开始使用.

## 核心功能

### 代码自动补全
实时获取AI代码建议，让twinny自动补全你的代码。
![Fill in the Middle Example](https://github.com/rjmacarthy/twinny/assets/5537428/69f567c0-2700-4474-b621-6099255bc87b)

### 基于代码进行智能聊天
通过边栏处理代码: 获取函数解释，生成测试，请求重构等。
<img src="https://github.com/user-attachments/assets/464c2762-1da7-4ff7-a3fd-c8703566924d" width="800"/>


### 附加功能
- 离线与在线运行
- 高度可定制的 FIM 和聊天 API 端点
- 保存聊天记录
- 满足OpneAI的API标准
- 支持单行或多行填空式补全
- 可定制的提示模板
- 从暂存的更改生成 git 提交消息
- 通过 Visual Studio Code 扩展市场轻松安装
- 可定制的设置，用于 API 提供商、模型名称、端口号和路径
- 与 Ollama、llama.cpp、oobabooga 和 LM Studio API 兼容
- 直接在编辑器中接受代码解决方案
- 从代码块创建新文档
- 查看代码块的并排差异
- 以全屏模式打开聊天
- 复制生成的代码解决方案块
- 工作区嵌入，用于上下文感知的 AI 助力
- 连接到 Symmetry 网络，进行 P2P AI 推理
- 成为 Symmetry 网络的提供商，与世界分享您的计算资源
  
### 工作区嵌入
使用工作区嵌入增强您的编码体验，获得上下文感知的 AI 助力。
- **嵌入您的整个工作区**: 只需单击即可轻松嵌入您的整个工作区。
- **上下文感知的响应**: twinny 使用您的代码库的相关部分，提供更准确和上下文的答案。
- **可定制的嵌入提供者**: 默认情况下，使用 Ollama 嵌入（all-minilm:latest），但支持各种提供者。
- **可调整的相关性**: 微调重新排名概率阈值，以控制 AI 响应中上下文的包含。
- **切换嵌入上下文**: 轻松在每次消息中使用或不用嵌入上下文之间切换。

### Symmetry 网络
[Symmetry](https://twinny.dev/symmetry)是一个去中心化的点对点网络工具，旨在为 AI 推理提供计算资源的民主化访问。主要功能包括:

- 资源共享: 用户可以提供或寻求计算能力，用于各种 AI 任务。
- 直接连接: 在用户之间启用安全、点对点的连接。
- Visual Studio Code 集成: Twinny 在 VS Code 中内置了直接作为对等体或提供者连接的功能。
- 公共提供者访问:用户可以利用 Symmetry 网络上其他用户的公共模型。

Symmetry 旨在为开发人员和研究人员提供更易于访问和高效的 AI 推理。

客户端源代码是开源的，可以在以下链接[获取](https://github.com/twinnydotdev/symmetry-core).

## 已知问题
访问Github[问题页面](https://github.com/rjmacarthy/twinny/issues) 查找已知问题和故障排除。

## 贡献
有兴趣贡献吗？在[Twitter](https://x.com/twinnydotdev)上联系我, 在问题中描述你的更改并在准备好时提交PR. Twinny 是在 MIT 许可下开源的。有关更多详细信息，请参阅 [LICENSE](https://github.com/rjmacarthy/twinny/blob/master/LICENSE) 。

## 支持 Twinny
感谢您使用 Twinny！
该项目将始终是免费且开源的。如果您觉得它对您有所帮助，请考虑通过小额捐赠来表达您的感谢 <3
Bitcoin: `1PVavNkMmBmUz8nRYdnVXiTgXrAyaxfehj`

关注我的X账号获得最新的更新 https://x.com/rjmacarthy

## 免责声明
Twinny 正在积极开发和提供“原样”。功能可能会在更新之间有所不同。
