import * as assert from 'assert'
import * as vscode from 'vscode'

import { CompletionFormatter } from '../../extension/completion-formatter'

suite('Completion formatter', () => {
  let editor: vscode.TextEditor

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  test('bracketed completions work correctly', async () => {
    const document = await vscode.workspace.openTextDocument()
    editor = await vscode.window.showTextDocument(document)
    const completionFormatter = new CompletionFormatter(editor)
    assert.strictEqual(completionFormatter.format('{\n\n'), '{')
    assert.strictEqual(completionFormatter.format('{'), '{')
    assert.strictEqual(completionFormatter.format('})'), '})')
    assert.strictEqual(completionFormatter.format('}'), '}')
    assert.strictEqual(completionFormatter.format('\n\n\n}'), '}')
    assert.strictEqual(completionFormatter.format('{{\n\n\n'), '{{')
  })

  test('removes duplicate closing bracket', async () => {
    const document = await vscode.workspace.openTextDocument({
      content: '\'\')'
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length - 1)
    editor.selection = new vscode.Selection(position, position)
    const completionFormatter = new CompletionFormatter(editor)
    assert.ok(editor, 'Editor should be defined')
    assert.strictEqual(completionFormatter.format('\')'), '\'')
  })

  test('removes duplicate closing quote', async () => {
    const document = await vscode.workspace.openTextDocument({
      content: '\'word\')}'
    })
    editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length - 3)
    editor.selection = new vscode.Selection(position, position)
    const completionFormatter = new CompletionFormatter(editor)
    assert.ok(editor, 'Editor should be defined')
    assert.strictEqual(completionFormatter.format('word\')}'), 'word')
  })

  test('removes duplicate closing quote inside word', async () => {
    const document = await vscode.workspace.openTextDocument({
      content: '\'wod\')}'
    })
    const editor = await vscode.window.showTextDocument(document)
    const position = new vscode.Position(0, document.lineAt(0).text.length - 4)
    editor.selection = new vscode.Selection(position, position)
    const completionFormatter = new CompletionFormatter(editor)
    assert.ok(editor, 'Editor should be defined')
    const formattedCompletion = completionFormatter.format('r\'')
    assert.strictEqual(formattedCompletion, 'r')
  })
})
