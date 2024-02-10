# twinny

Are you fed up of all of those so called "free" Copilot alternatives with paywalls and signups?  Fear not my developer friend!  Twinny is the most no-nonsense locally hosted (or api hosted) AI code completion plugin for Visual Studio Code designed to work seamlessly with [Ollama](https://github.com/jmorganca/ollama), [llama.cpp](https://github.com/ggerganov/llama.cpp) and [LM Studio](https://github.com/lmstudio-ai). Like Github Copilot but 100% free and 100% private.

<div align="center">
    <p>
      Install the twinny Visual Studio Code extension
    </p>
    <a href="https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny">
      <img src="https://code.visualstudio.com/assets/images/code-stable.png" height="50" />
    </a>
</div>

### Main features 

Fill in the middle code completion:

<img src="https://github.com/rjmacarthy/twinny/assets/5537428/69f567c0-2700-4474-b621-6099255bc87b" width="760"/>

Chat with AI about your code

<img src="https://github.com/rjmacarthy/twinny/assets/5537428/679bd283-28e9-47ff-9165-84dfe293c56a" width="760"/>

#### Other features 

- Configurable single or multiline fill-in-middle completions
- Configurable prompt templates add, edit, remove, delete and set as default
- Easy installation and setup
- Ollama, llamacpp and LM Studio API compatible
- Accept code solutions directly to editor
- Create new documents from code blocks
- Copy generated code solution blocks
- Chat history preserved per workspace

## 🚀 Getting Started

### Easy Installation

Install the verified extension at [this link](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny) or find the extension in the extensions section of Visual Studio Code marketplace.

Twinny is configured to use Ollama by deafult. Therefore, when installing the twinny extension in Visual Studio Code, it will automatically prompt and guide you through the installation of Ollama using two default small models `codellama:7b-instruct` for chat and `codellama:7b-code` for "fill in the middle" completions. 

If you already have Ollama installed or you want to use llama.cpp or LM Studio instead, you can cancel the automatic setup of Ollama and proceed to update the values inside twinny extension settings to point to your existing models and server.  At this point it's a good idea to set `Disable Server Checks` option to true which this will disable the checks on startup.

You can find the settings inside the extension sidebar by clicking the gear icon inside the twinny sidebar or by searching for `twinny` in the extensions search bar.

When choosing an API provider the port and API path names will be updated automatically based on the provider you choose to use.

If you are using llama.cpp - The twinny settings for FIM model name and Chat model name will be ignored, as this should already be configured when running the llama.cpp server.

When the extension is ready you will see a `🤖` icon at the bottom of your code editor.

Enjoy enhanced code completions and chat with twinny! 🎉

## Model support

**FIM**

- If using Llama the model must support the llama special tokens for prefix and suffix if using codellama models.
- If using deepseek only use base models for FIM completions for example `deepseek-coder:base` and `deepseek-coder:6.7b-base-q5_K_M`
- `stable-code:code` has been tested and works for FIM.

**Chat**

- All instruct models should work but prompt templates might need editing if using something other than codellama.

## Keyboard shortcuts

| Shortcut                     | Description                              |
| ---------------------------- | ---------------------------------------- |
| `ALT+\`                      | Trigger inline code completion           |
| `CTRL+SHIFT+t`               | Open twinny sidebar                      |
| `CTRL+SHIFT+/`               | Stop code generation                     | 

## Known issues

- If the server settings are incorrectly set chat and fim completion will not work, if this is the case please open an issue with your error message.
- Some models may not support the special tokens of Llama which means they would not work correctly for FIM completions.
- Sometimes a restart of vscode is required for new settings to take effect.
- Using file context often causes unreliable completions for FIM because small models get confused when provided with more than one file context.
- See open issues for more information 
  
If you have a suggestion for improvement please open an issue and I will do my best to make it happen!

## Contributing

We are actively looking for contributors who want to help improve the project, if you are interested in helping out please reach out on [twitter](https://x.com/rjmacarthy).

Contributions are welcome please open an issue describing your changes and open a pull request when ready.

This project is under MIT licence, please read the [LICENSE](https://github.com/rjmacarthy/twinny/blob/master/LICENSE) file for more information.
