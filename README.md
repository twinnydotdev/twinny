# twinny

Tired of the so-called "free" Copilot alternatives that are filled with paywalls and signups? Look no further, developer friend!

**Twinny** is your definitive, no-nonsense AI code completion plugin for **Visual Studio Code** and compatible editors like VSCodium. It's designed to integrate seamlessly with various tools and frameworks:

- [Ollama](https://github.com/jmorganca/ollama)
- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [oobabooga/text-generation-webui](https://github.com/oobabooga/text-generation-webui)
- [LM Studio](https://github.com/lmstudio-ai)
- [LiteLLM](https://github.com/BerriAI/litellm)
- [Open WebUI](https://github.com/open-webui/open-webui)

Like Github Copilot but **100% free**!

<div align="center">
    <a href="https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny">
      <img src="https://code.visualstudio.com/assets/images/code-stable.png" height="50" />
    </a>
    <p>
      Install Twinny on the Visual Studio Code extension marketplace.
    </p>
</div>

## Main Features

### Fill in the Middle Code Completion

Get AI-based suggestions in real time. Let Twinny autocomplete your code as you type.

![Fill in the Middle Example](https://github.com/rjmacarthy/twinny/assets/5537428/69f567c0-2700-4474-b621-6099255bc87b)

### Chat with AI About Your Code

Discuss your code via the sidebar: get function explanations, generate tests, request refactoring, and more.

<img src="https://github.com/rjmacarthy/twinny/assets/5537428/a5c5bb34-60f6-41f6-8226-c62cf4c17c1d" width="760"/>

### Additional Features

- Operates online or offline
- Highly customizable API endpoints for FIM and chat
- Chat conversations are preserved
- Conforms to the OpenAI API standard
- Supports single or multiline fill-in-middle completions
- Customizable prompt templates
- Generate git commit messages from staged changes
- Easy installation via the Visual Studio Code extensions marketplace
- Customizable settings for API provider, model name, port number, and path
- Compatible with Ollama, llama.cpp, oobabooga, and LM Studio APIs
- Accepts code solutions directly in the editor
- Creates new documents from code blocks
- Copies generated code solution blocks

## 🚀 Getting Started

### Setup with Ollama (Recommended)

1. Install the VS Code extension [here](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny) or [VSCodium here](https://open-vsx.org/extension/rjmacarthy/twinny).
2. Set up Ollama as the backend by default: [Install Ollama](https://ollama.com/)
3. Select your model from the [Ollama library](https://ollama.com/library) (e.g., `codellama:7b-instruct` for chats and `codellama:7b-code` for auto complete).

```sh
ollama run codellama:7b-instruct
ollama run codellama:7b-code
```

4. Open VS code (if already open a restart might be needed) and press `ctr + shift + T` to open the side panel.

You should see the 🤖 icon indicating that twinny is ready to use.

5. See [Keyboard shortcuts](#keyboard-shortcuts) to start using while coding 🎉

### Setup with Other Providers llama.cpp / LM Studio / Oobabooga / LiteLLM or any other provider

For setups with llama.cpp, LM Studio, Oobabooga, LiteLLM, or any other provider, you can find more details on provider configurations and functionalities [here in providers.md](https://github.com/rjmacarthy/twinny/blob/main/docs/providers.md).

1. Install the VS Code extension [here](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny).
2. Obtain and run your chosen model locally using the provider's setup instructions.
3. Restart VS Code if necessary and press `CTRL + SHIFT + T` to open the side panel.
4. At the top of the extension, click the 🔌 (plug) icon to configure your FIM and chat endpoints in the providers tab.
5. It is recommended to use separate models for FIM and chat as they are optimized for different tasks.
6. Update the provider settings for chat, including provider, port, and hostname to correctly connect to your chat model.
7. After setup, the 🤖 icon should appear in the sidebar, indicating that Twinny is ready for use.
8. Results may vary from provider to provider especailly if using the same model for chat and FIM interchangeably.

### With Non-Local API Providers e.g, OpenAI GPT-4 and Anthropic Claude

Twinny supports OpenAI API-compliant providers.

1. Use LiteLLM as your local proxy for the best compatibility.
2. If there are any issues, please [open an issue](https://github.com/rjmacarthy/twinny/issues/new/choose) on GitHub with details.

### Model Support

**Models for Chat:**
- For powerful machines: `deepseek-coder:6.7b-base-q5_K_M` or `codellama:7b-instruct`.
- For less powerful setups, choose a smaller instruct model for quicker responses, albeit with less accuracy.

**Models for FIM Completions:**
- High performance: `deepseek-coder:base` or `codellama:7b-code`.
- Lower performance: `deepseek-coder:1.3b-base-q4_1` for CPU-only setups.

## Keyboard Shortcuts

| Shortcut                    | Description                                      |
| ----------------------------| -------------------------------------------------|
| `ALT+\`                     | Trigger inline code completion                   |
| `CTRL+SHIFT+/`              | Stop the inline code generation                  | 
| `Tab`                       | Accept the inline code generated                 |
| `CTRL+SHIFT+Z CTRL+SHIFT+T` | Open Twinny sidebar                              |
| `CTRL+SHIFT+Z CTRL+SHIFT+G` | Generate commit messages from staged changes   |

## Workspace Context

Enable `fileContextEnabled` in settings to improve completion quality by tracking sessions and file access patterns. This is off by default to ensure performance.

## Known Issues

Visit the GitHub [issues page](https://github.com/rjmacarthy/twinny/issues) for known problems and troubleshooting.

## Contributing

Interested in contributing? Reach out on [Twitter](https://x.com/rjmacarthy), describe your changes in an issue, and submit a PR when ready. Twinny is open-source under the MIT license. See the [LICENSE](https://github.com/rjmacarthy/twinny/blob/master/LICENSE) for more details.

## Disclaimer

Twinny is actively developed and provided "as is". Functionality may vary between updates.

## Star History

<picture>
 <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=rjmacarthy/twinny&type=Date&theme=dark" />
 <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=rjmacarthy/twinny&type=Date" />
 <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=rjmacarthy/twinny&type=Date" />
</picture>
