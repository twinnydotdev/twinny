# Twinny

Twinny is a free AI extension for Visual Studio Code, offering powerful AI-assisted coding features.

## Supported Providers

- localhost OpenAI/Ollama Compatible API (default)
- [OpenAI](https://openai.com)
- [Anthropic](https://www.anthropic.com)
- [OpenRouter](https://openrouter.ai)
- [Deepseek](https://www.deepseek.com)
- [Cohere](https://www.cohere.ai)
- [Mistral AI](https://mistral.ai)
- [Perplexity](https://www.perplexity.ai)
- [Groq](https://groq.com)

## 🚀 Getting Started

For a quick start guide, visit our [documentation](https://twinnydotdev.github.io/twinny-docs/).

## Main Features

### Fill in the Middle Code Completion
Twinny provides AI-powered real-time code suggestions to enhance your coding experience.

### Chat with AI About Your Code
Use the sidebar to discuss your code with AI, getting explanations, tests, refactoring suggestions, and more.

### Additional Features
- Online and offline operation
- Customizable API endpoints
- Preserved chat conversations
- OpenAI API standard compliance
- Single and multiline fill-in-the-middle completions
- Customizable prompt templates
- Git commit message generation
- Easy installation via VS Code marketplace
- Configurable settings (API provider, model, port, path)
- Direct code solution acceptance
- New document creation from code blocks
- Side-by-side diff view
- Full-screen chat mode
- Code solution block copying
- Workspace embeddings for context-aware assistance
- Symmetry network integration for P2P AI inference

### Workspace Embeddings
Twinny uses workspace embeddings to provide context-aware AI assistance, improving the relevance of suggestions.

### Symmetry Network
A decentralized P2P network for sharing AI inference resources, enhancing the capabilities of Twinny.

## Known Issues

For troubleshooting and known issues, please check our GitHub [issues page](https://github.com/rjmacarthy/twinny/issues).

## Provider Configuration Storage

Twinny offers flexibility in how your provider configurations are stored. You can manage this using the `twinny.providerStorageLocation` setting in your VS Code `settings.json`.

Available options:

*   `"globalState"`: (Default) Stores provider configurations in VS Code's global state. This is tied to the current workspace/domain and might be lost if the domain changes frequently (e.g., in some code-server setups or when connecting to different remote environments).
*   `"file"`: Stores provider configurations in a JSON file (`twinny-providers.json`) within the extension's dedicated global storage directory. This method is more resilient to domain changes and is recommended for users experiencing issues with settings persistence or those who prefer file-based configuration management.

Upon first switching to `"file"`, Twinny will attempt to migrate any existing configurations from `globalState` to the new `twinny-providers.json` file.

### Importing and Exporting Providers

You can easily manage your provider configurations by importing and exporting them through the Twinny settings UI (accessible via the Twinny icon in the activity bar, then navigating to the "Providers" tab).

*   **Export Providers Button:** Clicking this button allows you to save all your current Twinny provider configurations into a single JSON file. You will be prompted to choose a name and location for this file. This is useful for backing up your settings or transferring them to another workspace or machine.
*   **Import Providers Button:** This button enables you to load provider configurations from a previously exported JSON file. When you select a valid JSON file, its contents will **replace** all your current provider configurations.
    *   **Caution:** Importing will overwrite your existing settings. If you want to keep your current setup, it's advisable to export it first as a backup before importing new configurations.

The expected file format for both import and export is a JSON object where each key is a unique provider ID, and the value is an object representing the provider's settings.

## Contributing

We welcome contributions! Please contact us via [Twitter](https://x.com/twinnydotdev), describe your proposed changes in an issue, and submit a pull request. Twinny is MIT licensed.

## Support Twinny

Twinny is free and open-source. If you'd like to support the project, donations are appreciated:
Bitcoin: `1PVavNkMmBmUz8nRYdnVXiTgXrAyaxfehj`

For updates, follow us on Twitter: https://x.com/twinnydotdev

## Disclaimer

Twinny is actively developed and provided "as is". Functionality may vary between updates.
