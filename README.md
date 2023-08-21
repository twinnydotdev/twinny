# Twinny

**Twinny** is a locally hosted AI code completion plugin for Visual Studio Code, designed to work seamlessly with the [twinny-api](https://github.com/rjmacarthy/twinny-api).

## 🚀 Getting Started

### Prerequisites
- Ensure you have the `twinny-api` running on your machine. If not, follow the instructions [here](https://github.com/rjmacarthy/twinny-api).

### Installation & Setup

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

## 📦 Packaging and Installation

For a more permanent solution, you can package Twinny into a `.vsix` file and then install it as a Visual Studio Code extension.

1. Package the plugin:

```
npm run package
```

2. This process will generate a `.vsix` file in the root directory. 
3. To install the `.vsix` file in Visual Studio Code:
- Open Visual Studio Code.
- Navigate to Extensions view by clicking on the square icon on the sidebar or pressing `Ctrl+Shift+X`.
- Click on the `...` (More Actions) button in the upper-right corner.
- Choose `Install from VSIX...` and select the generated `.vsix` file.

Enjoy enhanced code completions with **Twinny**! 🎉
