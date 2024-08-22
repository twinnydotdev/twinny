# twinny
Free and private AI extension for Visual Studio Code.

- [Ollama](https://github.com/jmorganca/ollama)
- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [oobabooga/text-generation-webui](https://github.com/oobabooga/text-generation-webui)
- [LM Studio](https://github.com/lmstudio-ai)
- [LiteLLM](https://github.com/BerriAI/litellm)
- [Open WebUI](https://github.com/open-webui/open-webui)

## 🚀 Getting Started
Visit the [quick start guide](https://twinnydotdev.github.io/twinny-docs/general/quick-start/) to get started.

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
- Workspace embeddings for context-aware AI assistance
- Connect to the Symmetry network for P2P AI inference
- Become a provider on the Symmetry network and share your computational resources with the world
  
### Workspace Embeddings
Enhance your coding experience with context-aware AI assistance using workspace embeddings.
- **Embed Your Workspace**: Easily embed your entire workspace with a single click.
- **Context-Aware Responses**: twinny uses relevant parts of your codebase to provide more accurate and contextual answers.
- **Customizable Embedding Provider**: By default, uses Ollama Embedding (all-minilm:latest), but supports various providers.
- **Adjustable Relevance**: Fine-tune the rerank probability threshold to control the inclusion of context in AI responses.
- **Toggle Embedded Context**: Easily switch between using embedded context or not for each message.

### Symmetry network
Symmetry is a decentralized peer-to-peer network tool designed to democratize access to computational resources for AI inference. Key features include:

- Resource Sharing: Users can offer or seek computational power for various AI tasks.
- Direct Connections: Enables secure, peer-to-peer connections between users.
- Visual Studio Code Integration: Twinny has built-in functionality to connect as a peer or provider directly within VS Code.
- Public Provider Access: Users can leverage models from other users who are public providers on the Symmetry network.

Symmetry aims to make AI inference more accessible and efficient for developers and researchers.

## Known Issues
Visit the GitHub [issues page](https://github.com/rjmacarthy/twinny/issues) for known problems and troubleshooting.

## Contributing
Interested in contributing? Reach out on [Twitter](https://x.com/twinnydotdev), describe your changes in an issue, and submit a PR when ready. Twinny is open-source under the MIT license. See the [LICENSE](https://github.com/rjmacarthy/twinny/blob/master/LICENSE) for more details.

## Support Twinny
Thanks for using Twinny! 
This project is and will always be free and open source. If you find it helpful, please consider showing your appreciation with a small donation <3
Bitcoin: `1PVavNkMmBmUz8nRYdnVXiTgXrAyaxfehj`

## Disclaimer
Twinny is actively developed and provided "as is". Functionality may vary between updates.
