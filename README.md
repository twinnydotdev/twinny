# twinny

<img src='https://raw.githubusercontent.com/rjmacarthy/twinny/master/assets/icon.png' width='100'>

### [Install the vscode extension](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny#review-details)

**twinny** is a locally hosted AI code completion plugin for Visual Studio Code, designed to work seamlessly with [ollama](https://github.com/jmorganca/ollama).

twinny is aptly named as your "twin" pair programmer, assisting you in writing code more efficiently and intelligently.

![twinny](https://github.com/rjmacarthy/twinny/assets/5537428/95a1d8d5-f2fb-47b3-b246-23ff822464c3)

The aim of twinny is to democratise the development of AI code completion tools, join me on this journey!

## 🚀 Getting Started

### Prerequisites

To make use of twinny properly, you will need to run the [ollama](https://github.com/jmorganca/ollama) API.

The easiest way to run the ollama API is to install ollama then run this command.

`
ollama run codellama:7b-code '<PRE> def compute_gcd(x, y): <SUF>return result <MID>'
`

Replace 7b with the model which you would like to run e.g 13b or 34b. Please make aure that you are using the `code` version. Once you have a reply from the ollama model the API should have started automatically along side it.

The extension will prompt and guide you through the installation of Ollama if you don't have it installed.

### Installation & Setup

Once you have the [ollama](https://github.com/jmorganca/ollama) API up and running you will need to install the extension.

You can install the verified extension using vscode or visit [this link](https://marketplace.visualstudio.com/items?itemName=rjmacarthy.twinny) for more information on how to install it.

When the extension is running and the Ollama server is running you will see a `🤖` icon at the bottom of your editor.

Enjoy enhanced code completions with **twinny**! 🎉

### Development and contributions

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

Contributions are welcome for both the extension and the API please open an issue describing your changes and open a pull request when ready.

This project is under MIT licence, please read the [LICENSE](https://github.com/rjmacarthy/twinny/blob/master/LICENSE) file for more information.
