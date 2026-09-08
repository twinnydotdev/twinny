import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { v4 as uuidv4 } from "uuid"
import {
  commands,
  ExtensionContext,
  languages,
  StatusBarAlignment,
  window,
  workspace
} from "vscode"
import * as vscode from "vscode"

import {
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  EXTENSION_NAME,
  TWINNY_COMMAND_NAME,
  WEBUI_TABS
} from "./common/constants"
import { logger } from "./common/logger"
import { getLineBreakCount } from "./common/text"
import { ContextItem, SelectionContextItem } from "./common/types"
import { FileInteractionCache } from "./extension/completion/file-interaction"
import { CompletionProvider } from "./extension/completion/provider"
import { setContext } from "./extension/context"
import { InlineEditCodeActionProvider } from "./extension/edit/code-actions"
import { InlineEditArgs, InlineEditService } from "./extension/edit/service"
import { EmbeddingDatabase } from "./extension/embeddings/database"
import { P2pRuntime } from "./extension/p2p/runtime"
import { setUpProvidersOnFirstRun } from "./extension/providers/setup"
import { ProviderStore } from "./extension/providers/store"
import { generateCommitMessage } from "./extension/review/commit-message"
import { SessionManager } from "./extension/session-manager"
import { TwinnyStatusBar } from "./extension/status-bar"
import { TemplateProvider } from "./extension/templates/provider"
import { delayExecution, sanitizeWorkspaceName } from "./extension/utils"
import { FullScreenProvider } from "./extension/webview/panel"
import { SidebarProvider } from "./extension/webview/sidebar"

/**
 * The editor commands whose answer is not a replacement for the selection
 * (prose, or a new file of tests): these go to the chat.
 */
const TEMPLATE_COMMANDS: Record<string, string> = {
  [TWINNY_COMMAND_NAME.explain]: "explain",
  [TWINNY_COMMAND_NAME.addTests]: "add-tests"
}

/** The editor commands that rewrite the selection in place, via inline edit. */
const EDIT_COMMANDS: Record<string, string> = {
  [TWINNY_COMMAND_NAME.refactor]:
    "Refactor this code to improve readability and efficiency without changing its behaviour.",
  [TWINNY_COMMAND_NAME.addTypes]:
    "Add precise type annotations, keeping the logic unchanged.",
  [TWINNY_COMMAND_NAME.generateDocs]:
    "Add documentation comments in the standard format for this language (JSDoc, docstrings, etc.). Keep the code itself unchanged."
}

/** Clicking the idle status bar item: the most-used toggles, one click away. */
async function showStatusBarMenu(statusBar: TwinnyStatusBar) {
  const config = workspace.getConfiguration("twinny")
  const autoSuggest = config.get<boolean>("autoSuggestEnabled", true)

  const picked = await window.showQuickPick(
    [
      {
        label: autoSuggest
          ? "$(circle-slash) Pause auto-suggest"
          : "$(play) Resume auto-suggest",
        description: autoSuggest
          ? "Completions only when triggered with Alt+\\"
          : "Suggest completions as you type",
        action: "toggle"
      },
      {
        label: "$(comment-discussion) Open chat",
        action: "chat"
      },
      {
        label: "$(robot) Manage providers",
        action: "providers"
      },
      {
        label: "$(gear) Settings",
        action: "settings"
      }
    ],
    { title: "Twinny", placeHolder: "What would you like to do?" }
  )

  switch (picked?.action) {
    case "toggle":
      await config.update(
        "autoSuggestEnabled",
        !autoSuggest,
        vscode.ConfigurationTarget.Global
      )
      statusBar.refresh()
      break
    case "chat":
      await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      await commands.executeCommand(TWINNY_COMMAND_NAME.openChat)
      break
    case "providers":
      await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      await commands.executeCommand(TWINNY_COMMAND_NAME.manageProviders)
      break
    case "settings":
      await commands.executeCommand(TWINNY_COMMAND_NAME.settings)
      break
  }
}

/**
 * Embeddings live in a per-workspace LanceDB under ~/.twinny. If that fails
 * to open (unsupported platform, corrupt directory) the rest of the
 * extension must still come up; only the embeddings tab goes without.
 */
async function openEmbeddingDatabase(
  context: ExtensionContext
): Promise<EmbeddingDatabase | undefined> {
  const workspaceName = sanitizeWorkspaceName(workspace.name)
  if (!workspaceName) return undefined

  try {
    const dbDir = path.join(os.homedir(), ".twinny/embeddings")
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
    const db = new EmbeddingDatabase(path.join(dbDir, workspaceName), context)
    await db.connect()
    return db
  } catch (error) {
    logger.error(
      `Embedding database unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return undefined
  }
}

export async function activate(context: ExtensionContext) {
  setContext(context)
  const statusBar = new TwinnyStatusBar(
    window.createStatusBarItem(StatusBarAlignment.Right),
    context
  )

  logger.log("Twinny extension starting")
  const templateDir = path.join(os.homedir(), ".twinny/templates") as string
  const templateProvider = new TemplateProvider(templateDir)
  const fileInteractionCache = new FileInteractionCache()
  const sessionManager = new SessionManager()

  // Paired GPU machines. The gateway must be up before any provider is read,
  // since a P2P provider's address is the gateway's.
  const p2p = new P2pRuntime(context)
  await p2p.start()

  // Nothing configured yet: use whichever local server is running, or say
  // so. Runs in the background; the sidebar waits on it before listing.
  const providerSetup = setUpProvidersOnFirstRun(
    context,
    new ProviderStore(context)
  )

  const fullScreenProvider = new FullScreenProvider(
    context,
    templateDir,
    statusBar,
    p2p
  )

  const db = await openEmbeddingDatabase(context)

  const sidebarProvider = new SidebarProvider(
    statusBar,
    context,
    templateDir,
    db,
    sessionManager,
    p2p
  )

  const completionProvider = new CompletionProvider(
    statusBar,
    fileInteractionCache,
    templateProvider,
    context
  )

  const inlineEdit = new InlineEditService(context, statusBar)

  templateProvider.init()

  const runTemplate = async (template: string) => {
    await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
    await sidebarProvider.waitForSidebarReady()
    sidebarProvider.streamTemplateCompletion(template)
  }

  const setEnabled = (enabled: boolean) =>
    workspace
      .getConfiguration("twinny")
      .update("enabled", enabled, vscode.ConfigurationTarget.Global)

  context.subscriptions.push(
    statusBar,
    p2p,
    fileInteractionCache,
    inlineEdit,
    languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      completionProvider
    ),
    languages.registerCodeActionsProvider(
      { scheme: "file" },
      new InlineEditCodeActionProvider(),
      {
        providedCodeActionKinds:
          InlineEditCodeActionProvider.providedCodeActionKinds
      }
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.edit, (args?: InlineEditArgs) =>
      inlineEdit.run(args)
    ),
    ...Object.entries(TEMPLATE_COMMANDS).map(([command, template]) =>
      commands.registerCommand(command, () => runTemplate(template))
    ),
    ...Object.entries(EDIT_COMMANDS).map(([command, instruction]) =>
      commands.registerCommand(command, () =>
        inlineEdit.run({ instruction, requireSelection: true })
      )
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.enable, () => setEnabled(true)),
    commands.registerCommand(TWINNY_COMMAND_NAME.disable, () =>
      setEnabled(false)
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.statusBarMenu, () =>
      showStatusBarMenu(statusBar)
    ),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.templateCompletion,
      (template: string) => runTemplate(template)
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.stopGeneration, () => {
      completionProvider.onError()
      sidebarProvider.destroyStream()
      inlineEdit.abort()
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.manageProviders, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyManageProviders,
        true
      )
      sidebarProvider.bridge?.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.providers)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.embeddings, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyEmbeddingsTab,
        true
      )
      sidebarProvider.bridge?.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.embeddings)
    }),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.conversationHistory,
      async () => {
        commands.executeCommand(
          "setContext",
          EXTENSION_CONTEXT_NAME.twinnyConversationHistory,
          true
        )
        sidebarProvider.bridge?.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.history)
      }
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.review, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyReviewTab,
        true
      )
      sidebarProvider.bridge?.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.review)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.manageTemplates, async () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyManageTemplates,
        true
      )
      sidebarProvider.bridge?.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.settings)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.hideBackButton, () => {
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyManageTemplates,
        false
      )
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyConversationHistory,
        false
      )
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyManageProviders,
        false
      )
      commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyReviewTab,
        false
      )
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.openChat, () => {
      commands.executeCommand(TWINNY_COMMAND_NAME.hideBackButton)
      sidebarProvider.bridge?.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.settings, () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        EXTENSION_NAME
      )
    }),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.generateCommitMessage,
      async () => {
        // The chat service only exists once the sidebar has been shown.
        if (!sidebarProvider.chat) {
          await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
          await sidebarProvider.waitForSidebarReady()
        }
        if (!sidebarProvider.chat) return
        await generateCommitMessage(sidebarProvider.chat, templateProvider)
      }
    ),
    // Turn this machine into a node and put a pairing code on the clipboard.
    commands.registerCommand(TWINNY_COMMAND_NAME.shareOllama, async () => {
      try {
        const status = await p2p.host.newPairingCode()
        if (status.pairingCode) {
          await vscode.env.clipboard.writeText(status.pairingCode)
        }
        const choice = await window.showInformationMessage(
          `Twinny is sharing this computer's Ollama as "${status.name}". ` +
            "A pairing code is on the clipboard; paste it into Twinny on your other device within ten minutes.",
          "Open providers"
        )
        if (choice) {
          await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
          await commands.executeCommand(TWINNY_COMMAND_NAME.manageProviders)
        }
      } catch (error) {
        window.showErrorMessage(
          `Twinny could not start sharing: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.newConversation, () => {
      sidebarProvider.bridge?.emit(EVENT_NAME.twinnyNewConversation)
      sidebarProvider.conversationHistory?.resetConversation()
      sidebarProvider.chat?.resetConversation()
      sidebarProvider.bridge?.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.openPanelChat, () => {
      commands.executeCommand("workbench.action.closeSidebar")
      fullScreenProvider.createOrShowPanel()
    }),
    // From the editor (no arguments), or the explorer (clicked uri plus the
    // whole multi-selection as the second argument).
    commands.registerCommand(
      TWINNY_COMMAND_NAME.addFileToContext,
      async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
        const uris = selected?.length
          ? selected
          : clicked
            ? [clicked]
            : window.activeTextEditor
              ? [window.activeTextEditor.document.uri]
              : []

        let added = 0
        for (const uri of uris) {
          if (uri.scheme !== "file") continue
          const stat = await workspace.fs.stat(uri).then(
            (s) => s,
            () => undefined
          )
          if (!stat || stat.type !== vscode.FileType.File) continue
          const filePath = workspace.asRelativePath(uri)
          const fileContextItem: ContextItem = {
            id: filePath,
            category: "files",
            name: path.basename(uri.fsPath),
            path: filePath
          }
          sidebarProvider.addContextItem(fileContextItem)
          added++
        }

        if (added === 0) {
          window.showInformationMessage("No file to add to the chat context.")
        } else if (uris.length > 1) {
          window.setStatusBarMessage(
            `Twinny: added ${added} files to the chat context`,
            4000
          )
        }
      }
    ),
    commands.registerCommand(
      TWINNY_COMMAND_NAME.addSelectionToContext,
      async () => {
        const editor = window.activeTextEditor
        if (editor && !editor.selection.isEmpty) {
          const selection = editor.selection
          const selectedText = editor.document.getText(selection)
          const filePath = workspace.asRelativePath(editor.document.uri.fsPath)
          const selectionContextItem: SelectionContextItem = {
            id: uuidv4(),
            category: "selection",
            name: `Selection from ${path.basename(filePath)} (L${
              selection.start.line + 1
            }-L${selection.end.line + 1})`,
            path: filePath,
            content: selectedText,
            selectionRange: {
              startLine: selection.start.line,
              startCharacter: selection.start.character,
              endLine: selection.end.line,
              endCharacter: selection.end.character
            }
          }
          if (sidebarProvider.addContextItem) {
            sidebarProvider.addContextItem(selectionContextItem)
          }
        } else {
          window.showInformationMessage("No text selected to add to context.")
        }
      }
    ),
    workspace.onDidCloseTextDocument((document) => {
      const filePath = document.uri.fsPath
      fileInteractionCache.endSession()
      fileInteractionCache.delete(filePath)
    }),
    workspace.onDidOpenTextDocument((document) => {
      const filePath = document.uri.fsPath
      fileInteractionCache.startSession(filePath)
      fileInteractionCache.incrementVisits()
    }),
    workspace.onDidChangeTextDocument((e) => {
      const changes = e.contentChanges[0]
      if (!changes) return
      const lastCompletion = completionProvider.lastCompletionText
      const isLastCompltionMultiline = getLineBreakCount(lastCompletion) > 1
      completionProvider.setAcceptedLastCompletion(
        !!(
          changes.text &&
          lastCompletion &&
          changes.text === lastCompletion &&
          isLastCompltionMultiline
        )
      )
      const currentLine = changes.range.start.line
      const currentCharacter = changes.range.start.character
      fileInteractionCache.incrementStrokes(currentLine, currentCharacter)
    }),
    window.registerWebviewViewProvider("twinny.sidebar", sidebarProvider),
    window.onDidChangeTextEditorSelection(() => {
      completionProvider.abortCompletion()
      delayExecution(() => {
        completionProvider.setAcceptedLastCompletion(false)
      }, 200)
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("twinny")) statusBar.refresh()
    })
  )

  statusBar.refresh()
  void providerSetup.then(() => statusBar.refresh())

  logger.log("Twinny extension activation complete")
}

export function deactivate() {
  logger.log("Twinny extension deactivated")
}
