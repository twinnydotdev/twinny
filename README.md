# twinny

Are you fed up of all of those so called "free" Copilot alternatives with paywalls and signups? Fear not my developer friend! Twinny is the most no-nonsense locally hosted (or api hosted) AI code completion plugin for Visual Studio Code and any compatible editors (like VSCodium) designed to work seamlessly with [Ollama](https://github.com/jmorganca/ollama), [Ollama Web UI](https://github.com/ollama-webui/ollama-webui), [llama.cpp](https://github.com/ggerganov/llama.cpp), [oobabooga/text-generation-webui](https://github.com/oobabooga/text-generation-webui) and [LM Studio](https://github.com/lmstudio-ai). Like Github Copilot but 100% free and 100% private.

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

### Easy Installation

For Visual Studio Code install the verified extension via the Visual Studio Code marketplace by clicking [this link](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny) or find the extension in the extensions section of Visual Studio Code.
For compatible editors (like VSCodium) install the extension from [open-vsx.org](https://open-vsx.org/extension/rjmacarthy/twinny).

Twinny is configured to use the Ollama API by default, however you can change this to use llama.cpp, LM Studio or Oobabooga by changing the API provider in the extension settings. You can find the settings inside the extension sidebar by clicking the gear icon inside the twinny sidebar or by searching for `twinny` in the extensions search bar.

Twinny supports the OpenAI API specification so in theory any API should work with Twinny as long as it supports the OpenAI specification.  If you find that isn't the case please open an issue with details of how you are having problems.

When choosing an API provider the port and API path names will be updated automatically based on the provider you choose to use. These options can also be set manually.

The option for chat model name and fim model name are only applicable to Ollama and Oobabooga providers.

When the extension is ready you will see a `🤖` icon at the bottom of your code editor indicating that twinny is ready to use.

Enjoy enhanced code completions and chat with twinny! 🎉

## Model support
Twinny can suggest code either while you are typing in the code editor (these are FIM completions) or you can prompt the model via Twinny's sidebar, in the same way you would chat with any LLM. You can even highlight code in the code editor and ask Twinny via the chat sidebar, to explain the code or provide suggestions. The smaller the size of the model, the faster the response will be.     
  
**Models for Chat**  
Among LLM models, there are models called "instruct models", which are designed for a question & answer mode of chat. All instruct models should work for chat generations, but the templates might need editing if using something other than codellama (they need to be updated with the special tokens).  
- For computers with a good GPU, use: `deepseek-coder:6.7b-base-q5_K_M` (or any other good instruct model).
     
**Models for Fill in the middle (FIM) completions**  
For FIM completions, you need to use LLM models called "base models". Unlike instruct models, base models will only try to complete your prompt. The are not designed to answer questions.
If using Llama the model must support the Llama special tokens. 
- For computers with a good GPU, use: `deepseek-coder:base` or `codellama-code` (or any other good model that is optimised for code completions).
- For slower computers or computers using only CPU, use `stable-code:3b-code-q4_0` (or any other small base model).
  

## Keyboard shortcuts

| Shortcut                     | Description                              |
| ---------------------------- | ---------------------------------------- |
| `ALT+\`                      | Trigger inline code completion           |
| `CTRL+SHIFT+/`               | Stop the inline code generation          | 
| `Tab`                        | Accept the inline code generated         |
| `CTRL+SHIFT+t`               | Open twinny sidebar                      |


## Workspace context

In the settings there is an option called `useFileContext` this will keep track of sessions, keystrokes, visits and recency of visited files in the current workspace.  This can be enabled to help improve the quality of completions, it's turned off by default but I'm considering turning this on by default in the next release.

## Known issues

- If the server settings are incorrectly set chat and fim completion will not work, if this is the case please open an issue with your error message.
- Sometimes a restart of vscode is required for new settings to take effect, please open an issue if you are having problems with this.
- Using file context often causes unreliable completions for FIM because small models get confused when provided with more than one file context.
- See open issues on github to see any known issues that are not yet fixed.
  
If you have a problem with Twinny or have any suggestions please report them on github issues.  Please include your vscode version and OS details in your issue.

## Contributing

We are actively looking for contributors who want to help improve the project, if you are interested in helping out please reach out on [twitter](https://x.com/rjmacarthy).

Contributions are welcome please open an issue describing your changes and open a pull request when ready.

This project is under MIT licence, please read the [LICENSE](https://github.com/rjmacarthy/twinny/blob/master/LICENSE) file for more information.

## Disclaimer

This plugin is provided "as is" and is under active development.  This means that at times it may not work fully as expected.
