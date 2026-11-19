import * as assert from "assert"
import * as vscode from "vscode"

import { FileInteractionCache } from "../../extension/completion/file-interaction"
import { joinCells, textDocumentOf } from "../../extension/completion/notebook"
import { CompletionProvider } from "../../extension/completion/provider"
import { GenerationTracker } from "../../extension/generations"
import { TemplateProvider } from "../../extension/templates/provider"
import { getPrefixSuffix } from "../../extension/utils"

const cell = (kind: vscode.NotebookCellKind, value: string, languageId = "python") =>
  new vscode.NotebookCellData(kind, value, languageId)

suite("FIM in notebooks (#430)", () => {
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  })

  test("a string is windowed exactly like a document holding it", async () => {
    const text = Array.from({ length: 60 }, (_, i) => (i % 7 === 3 ? "" : `value_${i} = compute(${i})`)).join("\n")
    const document = await vscode.workspace.openTextDocument({ content: text, language: "python" })
    const view = textDocumentOf(text)
    assert.strictEqual(view.lineCount, document.lineCount)
    assert.strictEqual(view.getText(), text)
    for (const line of [0, 1, 3, 20, 59]) {
      for (const character of [0, 4, 200]) {
        const position = document.validatePosition(new vscode.Position(line, character))
        assert.deepStrictEqual(
          getPrefixSuffix(10, view, position),
          getPrefixSuffix(10, document, position),
          `at ${line}:${character}`
        )
      }
    }
    // Ranges past a line's end or the last line are clamped, as a document clamps them.
    for (const range of [new vscode.Range(55, 0, 70, 0), new vscode.Range(2, 50, 4, 300), new vscode.Range(0, 3, 0, 3)]) {
      assert.strictEqual(view.getText(range), document.getText(range))
    }
  })

  test("the code cells in the cell's language are joined, and the cell's first line is found", async () => {
    const notebook = await vscode.workspace.openNotebookDocument(
      "jupyter-notebook",
      new vscode.NotebookData([
        cell(vscode.NotebookCellKind.Code, "import pandas as pd\nframe = pd.read_csv('sales.csv')"),
        cell(vscode.NotebookCellKind.Markup, "# Totals", "markdown"),
        cell(vscode.NotebookCellKind.Code, "SELECT * FROM sales", "sql"),
        cell(vscode.NotebookCellKind.Code, "totals = frame.groupby('region')"),
        cell(vscode.NotebookCellKind.Code, "totals.plot()")
      ])
    )
    const joined = joinCells(notebook.getCells(), notebook.cellAt(3).document)
    assert.deepStrictEqual(joined, {
      text: "import pandas as pd\nframe = pd.read_csv('sales.csv')\n\ntotals = frame.groupby('region')\n\ntotals.plot()",
      line: 3
    })
    assert.strictEqual(joinCells(notebook.getCells(), notebook.cellAt(0).document)?.line, 0)
    const other = await vscode.workspace.openTextDocument({ content: "x", language: "python" })
    assert.strictEqual(joinCells(notebook.getCells(), other), undefined)
  })

  test("a completion in a cell is asked with the cells round it", async () => {
    const notebook = await vscode.workspace.openNotebookDocument(
      "jupyter-notebook",
      new vscode.NotebookData([
        cell(vscode.NotebookCellKind.Code, "import pandas as pd\nframe = pd.read_csv('sales.csv')"),
        cell(vscode.NotebookCellKind.Code, "totals = "),
        cell(vscode.NotebookCellKind.Code, "totals.plot()")
      ])
    )
    const context = { globalState: { get: () => ({ id: "test", modelName: "test" }) } } as unknown as vscode.ExtensionContext
    const provider = new CompletionProvider(
      new GenerationTracker(),
      new FileInteractionCache(),
      {} as TemplateProvider,
      context
    )
    const asked: { prefix: string; suffix: string }[] = []
    Object.assign(provider, {
      config: {
        get(key: string, fallback: unknown) {
          if (key === "enabled" || key === "autoSuggestEnabled") return true
          return fallback
        }
      },
      // Observe what the model would be shown without calling one.
      async complete(request: { prefixSuffix: { prefix: string; suffix: string } }) {
        asked.push(request.prefixSuffix)
        return undefined
      }
    })
    const source = new vscode.CancellationTokenSource()
    try {
      await provider.provideInlineCompletionItems(
        notebook.cellAt(1).document,
        new vscode.Position(0, 9),
        { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
        source.token
      )
      assert.deepStrictEqual(asked, [{
        prefix: "import pandas as pd\nframe = pd.read_csv('sales.csv')\n\ntotals = ",
        suffix: "\n\ntotals.plot()"
      }])
    } finally {
      source.dispose()
      provider.dispose()
    }
  })
})
