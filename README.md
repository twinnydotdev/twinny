# twinny

Are you fed up of all of those so called "free" Copilot alternatives with paywalls and signups? Fear not my developer friend! 

Twinny is the most no-nonsense locally hosted (or api hosted) AI code completion plugin for **Visual Studio Code** and any compatible editors (like VSCodium) designed to work seamlessly with: 

- [Ollama](https://github.com/jmorganca/ollama)
- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [oobabooga/text-generation-webui](https://github.com/oobabooga/text-generation-webui)
- [LM Studio](https://github.com/lmstudio-ai)
- [LiteLLM](https://github.com/BerriAI/litellm)
- [Ollama Web UI](https://github.com/ollama-webui/ollama-webui)


Like Github Copilot but 100% free!

<div align="center">
    <a href="https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny">
      <img src="https://code.visualstudio.com/assets/images/code-stable.png" height="50" />
    </a>
    <p>
      Install twinny on the <br/> 
      Visual Studio Code extension marketplace
    </p>
</div>


## Main features

#### Fill in the middle code completion

Get AI based suggestions in real time. While coding you can let twinny autocomplete the code as you are typing.

<img src="https://github.com/rjmacarthy/twinny/assets/5537428/69f567c0-2700-4474-b621-6099255bc87b" width="760"/>

#### Chat with AI about your code

Through the side bar, have a conversation with your model and get explanations about a function, ask it to write tests, ask for a refactor and much more.

<img src="https://github.com/rjmacarthy/twinny/assets/5537428/679bd283-28e9-47ff-9165-84dfe293c56a" width="760"/>

#### Other features 

- Works online or offline
- Highly configurable api endpoints for fim and chat
- Conforms to the OpenAI API standard
- Single or multiline fill-in-middle completions
- Customisable prompt templates to add context to completions
- Easy installation via vscode extensions marketplace or by downloading and running a binary directly
- Customisable settings to change API provider, model name, port number and path 
- Ollama, llamacpp, oobabooga and LM Studio API compatible
- Accept code solutions directly to editor
- Create new documents from code blocks
- Copy generated code solution blocks
- Chat history preserved per workspace

## 🚀 Getting Started

### With Ollama

1. Install the VS code extension [link](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny) (or if [VSCodium](https://open-vsx.org/extension/rjmacarthy/twinny))
2. Twinny is configured to use Ollama by default as the backend, you can install Ollama here: [ollama](https://ollama.com/)
3. Choose your model from the [library](https://ollama.com/library) (eg: `codellama:7b`)

```sh
ollama run codellama:7b
```

4. Open VS code (if already open a restart might be needed) and press `ctr + shift + T` to open the side panel.

You should see the 🤖 icon indicating that twinny is ready to use.

5. See [Keyboard shortcuts](#keyboard-shortcuts) to start using while coding 🎉

### With llama.cpp / LM Studio / Oobabooga / LiteLLM or any other provider.

1. Install the VS code extension [link](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny) (or if [VSCodium](https://open-vsx.org/extension/rjmacarthy/twinny))
2. Get [llama.cpp](https://github.com/ggerganov/llama.cpp) / LM Studio / Oobabooga / LiteLLM
3. Download and run the model locally using the chosen provider
4. Open VS code (if already open a restart might be needed) and press `ctr + shift + T` to open the side panel.
5. From the top ⚙️ icon open the settings page and in the `Api Provider` panel change from `ollama` to `llamacpp` (or others respectively).
6. Update the settings for chat provider, port and hostname etc to be the correct. Please adjust carefully for other providers.
7. In the left panel you should see the 🤖 icon indicating that twinny is ready to use.
8. See [Keyboard shortcuts](#keyboard-shortcuts) to start using while coding 🎉

### With other providers

Twinny supports the OpenAI API specification so in theory any provider should work as long as it supports the specification.

The easiest way to use OpenAI API through twinny is to use LiteLLM as your procvider as a local proxy, it works seamlessly if configured correctly.

If you find that isn't the case please [open an issue](https://github.com/rjmacarthy/twinny/issues/new/choose) with details of how you are having problems.

#### Note!

When choosing an API provider the port and API path names will be updated automatically based on the provider you choose to use. These options can also be set manually.

The option for chat model name and fim model name are only applicable to Ollama and Oobabooga providers.

## Model support

Twinny works with any model as long as it can run on your machine and it exposes a OpenAI API compliant endpoint.

Choosing a model is influenced a lot by the machine it will be running, a smaller model will give you a faster response but with a loss in accuracy. 

There are two functionalities that twinny are expecting from a model: 

### **Models for Chat**

Among LLM models, there are models called "instruct models", which are designed for a question & answer mode of chat. 

All instruct models should work for chat generations, but the templates might need editing if using something other than codellama (they need to be updated with the special tokens).

- For computers with a good GPU, use: `deepseek-coder:6.7b-base-q5_K_M` (or any other good instruct model).
  
### **Models for FIM (fill in the middle) completions**

For FIM completions, you need to use LLM models called "base models". Unlike instruct models, base models will only try to complete your prompt. They are not designed to answer questions.

If using Llama the model must support the Llama special tokens. 

- For computers with a good GPU, use: `deepseek-coder:base` or `codellama-code` (or any other good model that is optimised for code completions).
- For slower computers or computers using only CPU, use `deepseek-coder:1.3b-base-q4_1` (or any other small base model).
  

## Keyboard shortcuts

| Shortcut                     | Description                              |
| ---------------------------- | ---------------------------------------- |
| `ALT+\`                      | Trigger inline code completion           |
| `CTRL+SHIFT+/`               | Stop the inline code generation          | 
| `Tab`                        | Accept the inline code generated         |
| `CTRL+SHIFT+t`               | Open twinny sidebar                      |


## Workspace context

In the settings there is an option called `useFileContext` this will keep track of sessions, keystrokes, visits and recency of visited files in the current workspace.  This can be enabled to help improve the quality of completions, it's turned off by default.

## Known issues

- If the server settings are incorrectly set chat and fim completion will not work, if this is the case please open an issue with your error message.
- Sometimes a restart of vscode is required for new settings to take effect, please open an issue if you are having problems with this.
- Using file context often causes unreliable completions for FIM because small models get confused when provided with more than one file context.
- See open issues on github to see any known issues that are not yet fixed.
- LiteLLM fim template needs invetigation
  

If you have a problem with Twinny or have any suggestions please report them on github issues.  Please include your vscode version and OS details in your issue.

## Contributing

We are actively looking for contributors who want to help improve the project, if you are interested in helping out please reach out on [twitter](https://x.com/rjmacarthy).

Contributions are welcome please open an issue describing your changes and open a pull request when ready.

This project is under MIT licence, please read the [LICENSE](https://github.com/rjmacarthy/twinny/blob/master/LICENSE) file for more information.

## Disclaimer

This plugin is provided "as is" and is under active development.  This means that at times it may not work fully as expected.
