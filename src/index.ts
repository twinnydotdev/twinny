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
import { ContextItem, SelectionContextItem } from "./common/types"
import { generateCommitMessage } from "./extension/commit-message"
import { setContext } from "./extension/context"
import { EmbeddingDatabase } from "./extension/embeddings"
import { FileInteractionCache } from "./extension/file-interaction"
import { CompletionProvider } from "./extension/providers/completion"
import { FullScreenProvider } from "./extension/providers/panel"
import { SidebarProvider } from "./extension/providers/sidebar"
import { SessionManager } from "./extension/session-manager"
import { TwinnyStatusBar } from "./extension/status-bar"
import { TemplateProvider } from "./extension/template-provider"
import { delayExecution, sanitizeWorkspaceName } from "./extension/utils"
import { getLineBreakCount } from "./webview/utils"

/** The editor commands that hand a selection to a chat template. */
const TEMPLATE_COMMANDS: Record<string, string> = {
  [TWINNY_COMMAND_NAME.explain]: "explain",
  [TWINNY_COMMAND_NAME.addTypes]: "add-types",
  [TWINNY_COMMAND_NAME.refactor]: "refactor",
  [TWINNY_COMMAND_NAME.generateDocs]: "generate-docs",
  [TWINNY_COMMAND_NAME.addTests]: "add-tests"
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
  const fullScreenProvider = new FullScreenProvider(
    context,
    templateDir,
    statusBar
  )

  const db = await openEmbeddingDatabase(context)

  const sidebarProvider = new SidebarProvider(
    statusBar,
    context,
    templateDir,
    db,
    sessionManager
  )

  const completionProvider = new CompletionProvider(
    statusBar,
    fileInteractionCache,
    templateProvider,
    context
  )

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
    fileInteractionCache,
    languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      completionProvider
    ),
    ...Object.entries(TEMPLATE_COMMANDS).map(([command, template]) =>
      commands.registerCommand(command, () => runTemplate(template))
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
    commands.registerCommand(TWINNY_COMMAND_NAME.addFileToContext, () => {
      const editor = window.activeTextEditor
      if (editor) {
        const filePath = workspace.asRelativePath(editor.document.uri.fsPath)
        const fileContextItem: ContextItem = {
          id: filePath, // Use filePath as the ID for files
          category: "files",
          name: path.basename(editor.document.uri.fsPath),
          path: filePath
        }
        if (sidebarProvider.addContextItem) {
          sidebarProvider.addContextItem(fileContextItem)
        }
      }
    }),
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

  logger.log("Twinny extension activation complete")
}

export function deactivate() {
  logger.log("Twinny extension deactivated")
}
