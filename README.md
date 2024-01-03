# twinny

<br>

Are you fed up of all of those so called "Free" Copilot alternatives with paywalls and signups?  Fear not my developmer friend!  Twinny is the most no-nonsense locally hosted (or api hosted) AI code completion plugin for vscode designed to work seamlessly with [Ollama](https://github.com/jmorganca/ollama). Like Github Copilot but 100% free and 100% private.

<br>

<div align="center">
    <p>
      Install the twinny vscode extension
    </p>
    <a href="https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny">
      <img src="https://code.visualstudio.com/assets/images/code-stable.png" height="50" />
    </a>
</div>



## 🚀 Getting Started

### Easy Installation

twinny and [Ollama](https://github.com/jmorganca/ollama) are designed to work together. When installing the twinny extension in Visual Studio Code, it will automatically prompt and guide you through the installation of Ollama using two default small models `codellama:7b-instruct` for chat and `codellama:7b-code` for "fill in the middle".

You can install the verified extension at [this link](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny)

When the extension is running and the Ollama server is running you will see a `🤖` icon at the bottom of your code editor which indicates which models are running.

That's it! Enjoy enhanced code completions and chat with twinny! 🎉

## 🤖 Features

- Auto code completion
- Fast and accurate
- Multiple language support
- Easy to install
- Free
- Private
- Configurable endpoint and port for Ollama API
- Chat feature like Copilot Chat
- View diff for code completions
- Accept solution directly to editor
- Copy generated code solution blocks
- Chat history preserved per conversation

Completion:

![twinny](https://github.com/rjmacarthy/twinny/assets/5537428/95a1d8d5-f2fb-47b3-b246-23ff822464c3)

Chat:

<img src="https://github.com/rjmacarthy/twinny/assets/5537428/56373e39-3f25-4db8-9c55-612289f3fde3" width="760"/>

## Development and contributions

1. Clone this repository:

```
git clone https://github.com/rjmacarthy/twinny.git
```

2. Navigate to the cloned directory:

```
cd twinny
```

3. Install the necessary dependencies:

```
npm install
```

4. Start the plugin in development mode by pressing `F5` within Visual Studio Code.

Contributions are welcome please open an issue describing your changes and open a pull request when ready.

This project is under MIT licence, please read the [LICENSE](https://github.com/rjmacarthy/twinny/blob/master/LICENSE) file for more information.
