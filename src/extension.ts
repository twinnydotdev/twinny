import {
  commands,
  ExtensionContext,
  languages,
  StatusBarAlignment,
  window,
  workspace
} from 'vscode'

import { CompletionProvider } from './completion'
import { init } from './init'
import { SidebarProvider } from './sidebar'
import { streamResponse } from './utils'

export async function activate(context: ExtensionContext) {
  const config = workspace.getConfiguration('twinny')
  const model = config.get('ollamaModelName') as string
  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right)

  try {
    await init()
  } catch (e) {
    console.error(e)
  }

  statusBar.text = '🤖'
  statusBar.tooltip = `twinny is running: ${model}`

  const completionProvider = new CompletionProvider(statusBar)
  const sidebarProvider = new SidebarProvider(context.extensionUri)

  context.subscriptions.push(
    languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      completionProvider
    ),
    commands.registerCommand('twinny.enable', () => {
      statusBar.show()
    }),
    commands.registerCommand('twinny.disable', () => {
      statusBar.hide()
    }),
    commands.registerCommand('twinny.explain', () => {
      const editor = window.activeTextEditor
      if (editor) {
        const selection = editor.selection
        const text = editor.document.getText(selection)
        console.log(`Selected: ${text}`)
        let completion = ''
        streamResponse(
          {
            hostname: 'localhost',
            port: 11434,
            method: 'POST',
            path: '/api/generate'
          },
          {
            model: 'codellama',
            prompt: `Refactor this code in a markdown window ${text}`
          },
          (chunk, onComplete) => {
            try {
              const json = JSON.parse(chunk)
              completion = completion + json.response
              sidebarProvider._view?.webview.postMessage({
                type: 'onSelectedText',
                value: completion
              })
              if (json.response.match('<EOT>')) {
                onComplete()
              }
            } catch (error) {
              console.error('Error parsing JSON:', error)
              return
            }
          }
        )
      }
    }),
    window.registerWebviewViewProvider('twinny-sidebar', sidebarProvider),
    statusBar
  )

  if (config.get('enabled')) {
    statusBar.show()
  }

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('twinny')) {
        return
      }

      completionProvider.updateConfig()
    })
  )
}
