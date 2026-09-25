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
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  EXTENSION_NAME,
  TEAM_NUDGE_STORAGE_KEY,
  TWINNY_COMMAND_NAME,
  URL_TEAMS,
  WEBUI_TABS
} from "./common/constants"
import { messageOf } from "./common/errors"
import { formatMs, logger } from "./common/logger"
import { getLineBreakCount } from "./common/text"
import { ContextItem, SelectionContextItem } from "./common/types"
import { FileInteractionCache } from "./extension/completion/file-interaction"
import { CompletionProvider } from "./extension/completion/provider"
import { setContext } from "./extension/context"
import { InlineEditCodeActionProvider } from "./extension/edit/code-actions"
import { InlineEditCodeLensProvider } from "./extension/edit/code-lens"
import { InlineEditArgs, InlineEditService } from "./extension/edit/service"
import { WorkspaceIndex } from "./extension/embeddings"
import { GenerationTracker } from "./extension/generations"
import { P2pRuntime } from "./extension/p2p/runtime"
import { RemoteCredentials } from "./extension/providers/credentials"
import { providerUrl } from "./extension/providers/errors"
import { TwinnyProvider } from "./extension/providers/manager"
import { TeamPolicyStore } from "./extension/providers/policy"
import { setUpProvidersOnFirstRun } from "./extension/providers/setup"
import { ProviderStore } from "./extension/providers/store"
import { teamSession } from "./extension/providers/team"
import { generateCommitMessage } from "./extension/review/commit-message"
import { SessionManager } from "./extension/session-manager"
import { TwinnyStatusBar } from "./extension/status-bar"
import { TeamShare } from "./extension/team/share"
import { TemplateProvider } from "./extension/templates/provider"
import { terminalHistory } from "./extension/terminal"
import { runDescribedCommand } from "./extension/terminal/command"
import { fixTerminalError } from "./extension/terminal/fix"
import { delayExecution } from "./extension/utils"
import { FullScreenProvider } from "./extension/webview/panel"
import { SidebarProvider } from "./extension/webview/sidebar"

/**
 * The editor commands whose answer is prose rather than code: these go
 * to the chat.
 */
const TEMPLATE_COMMANDS: Record<string, string> = {
  [TWINNY_COMMAND_NAME.explain]: "explain"
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
      },
      {
        label: "$(output) Show logs",
        description: "Requests, timings and errors in the Output panel",
        action: "logs"
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
    case "logs":
      logger.show()
      break
  }
}

/** `codellama:7b-code via Ollama at http://localhost:11434/api/generate`. */
const describeProvider = (provider: TwinnyProvider | undefined) =>
  provider
    ? `${provider.modelName} via ${provider.label} at ${providerUrl(provider) || "(no address)"}`
    : "none"

/** What a bug report needs first: version, editor, and which models are wired up. */
const logStartup = (context: ExtensionContext, startedAt: number) => {
  const version = context.extension.packageJSON.version
  const read = (key: string) => context.globalState.get<TwinnyProvider>(key)
  logger.info(
    `Twinny ${version} ready in ${formatMs(Date.now() - startedAt)} · ` +
      `VS Code ${vscode.version} · ${os.platform()} ${os.release()}`
  )
  logger.info(`  completions: ${describeProvider(read(ACTIVE_FIM_PROVIDER_STORAGE_KEY))}`)
  logger.info(`  chat:        ${describeProvider(read(ACTIVE_CHAT_PROVIDER_STORAGE_KEY))}`)
  logger.info(`  embeddings:  ${describeProvider(read(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY))}`)
}

export async function activate(context: ExtensionContext) {
  setContext(context)
  // Every model request runs on the tracker: the spinner, the stop
  // keybinding and the stop command all read it.
  const generations = new GenerationTracker()
  context.subscriptions.push(
    generations.onDidChange(({ stoppable }) => {
      void commands.executeCommand(
        "setContext",
        EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
        stoppable
      )
    })
  )
  const statusBar = new TwinnyStatusBar(
    window.createStatusBarItem(StatusBarAlignment.Right),
    context,
    generations
  )

  const startedAt = Date.now()
  const templateDir = path.join(os.homedir(), ".twinny/templates") as string
  const templateProvider = new TemplateProvider(templateDir)
  const fileInteractionCache = new FileInteractionCache()
  const sessionManager = new SessionManager()

  // Paired GPU machines. The gateway must be up before any provider is read,
  // since a P2P provider's address is the gateway's.
  const p2p = new P2pRuntime(context)
  await p2p.start()

  // Gateway tokens live in secret storage; requests read them from memory.
  const credentials = new RemoteCredentials(context)
  await credentials.load(Object.values(await new ProviderStore(context).getProviders()))
  context.subscriptions.push(credentials)

  // Nothing configured yet: use whichever local server is running, or say
  // so. Runs in the background; the sidebar waits on it before listing.
  const providerSetup = setUpProvidersOnFirstRun(
    context,
    new ProviderStore(context)
  )

  // This computer as part of the team's pool, when the developer switched
  // it on. Resumes after the team connection's key is loaded.
  const teamShare = new TeamShare(context, () =>
    teamSession(new ProviderStore(context), credentials, new TeamPolicyStore(context.globalState))
  )
  void teamShare.autoStart()

  const fullScreenProvider = new FullScreenProvider(
    context,
    templateDir,
    generations,
    p2p,
    teamShare
  )

  const workspaceIndex = await WorkspaceIndex.open(context)
  if (workspaceIndex) context.subscriptions.push(workspaceIndex)

  const sidebarProvider = new SidebarProvider(
    generations,
    context,
    templateDir,
    workspaceIndex,
    sessionManager,
    p2p,
    teamShare
  )

  const completionProvider = new CompletionProvider(
    generations,
    fileInteractionCache,
    templateProvider,
    context
  )

  const inlineEdit = new InlineEditService(context, generations)
  // After activation has settled, so loading the model does not compete with it.
  setTimeout(() => completionProvider.warmModel("startup"), 3000)

  templateProvider.init()

  const runTemplate = async (template: string) => {
    await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
    await sidebarProvider.waitForSidebarReady()
    sidebarProvider.streamTemplateCompletion(template)
  }

  // The chat service only exists once the sidebar has been shown.
  const requireChat = async () => {
    if (!sidebarProvider.chat) {
      await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
      await sidebarProvider.waitForSidebarReady()
    }
    return sidebarProvider.chat
  }

  const setEnabled = (enabled: boolean) =>
    workspace
      .getConfiguration("twinny")
      .update("enabled", enabled, vscode.ConfigurationTarget.Global)

  // vscode://rjmacarthy.twinny/join?url=…&code=…  (an admin's invite link)
  // vscode://rjmacarthy.twinny/team?url=…          (the gateway address alone)
  // Either opens the Providers tab on Connect to team; an invite is opened
  // by the extension first, so the key never passes through the browser.
  const openTeamLink = async (uri: vscode.Uri) => {
    const params = new URLSearchParams(uri.query)
    const url = params.get("url")?.trim() ?? ""
    const code = params.get("code")?.trim() || undefined
    if (!url) {
      void window.showWarningMessage("That Twinny link names no gateway. Ask your admin for a new invite.")
      return
    }
    await commands.executeCommand(TWINNY_COMMAND_NAME.focusSidebar)
    await sidebarProvider.waitForSidebarReady()
    const providers = sidebarProvider.providers
    if (!providers) {
      logger.warn("Team link opened before the sidebar's providers were ready")
      return
    }
    const open = await providers.openTeam({ url, code })
    if (open.invite) {
      void window.showInformationMessage(`Welcome, ${open.invite.name}. Confirm the team's models in the Twinny sidebar to finish connecting.`)
    } else if (open.error) {
      void window.showWarningMessage(`Twinny could not open the invite: ${open.error}`)
    }
  }

  context.subscriptions.push(
    statusBar,
    p2p,
    teamShare,
    fileInteractionCache,
    completionProvider,
    inlineEdit,
    terminalHistory,
    window.registerUriHandler({
      handleUri: (uri) => {
        if (uri.path === "/join" || uri.path === "/team") {
          openTeamLink(uri).catch((error) => logger.error(`Team link failed: ${messageOf(error)}`))
        }
      }
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.showLogs, () => logger.show()),
    commands.registerCommand(TWINNY_COMMAND_NAME.setUpTeam, () =>
      vscode.env.openExternal(vscode.Uri.parse(URL_TEAMS))
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.terminalCommand, async () => {
      const chat = await requireChat()
      if (chat) await runDescribedCommand(chat, terminalHistory)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.fixTerminalError, async () => {
      const chat = await requireChat()
      if (chat) await fixTerminalError(chat, terminalHistory)
    }),
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
    languages.registerCodeLensProvider(
      { pattern: "**" },
      new InlineEditCodeLensProvider(inlineEdit)
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.edit, (args?: InlineEditArgs) =>
      inlineEdit.run(args)
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.acceptEdit, (hunk?: number) =>
      inlineEdit.accept(typeof hunk === "number" ? hunk : undefined)
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.rejectEdit, (hunk?: number) =>
      inlineEdit.reject(typeof hunk === "number" ? hunk : undefined)
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.applyCode, (code: string) =>
      inlineEdit.propose(String(code ?? ""))
    ),
    commands.registerCommand(TWINNY_COMMAND_NAME.addTests, () =>
      inlineEdit.writeTests()
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
    commands.registerCommand(TWINNY_COMMAND_NAME.stopGeneration, () =>
      generations.stopAll()
    ),
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
        const chat = await requireChat()
        if (chat) await generateCommitMessage(chat, templateProvider)
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
            messageOf(error)
          }`
        )
      }
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.newConversation, () => {
      sidebarProvider.newConversation()
      sidebarProvider.bridge?.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
    }),
    commands.registerCommand(TWINNY_COMMAND_NAME.exportConversation, () =>
      sidebarProvider.bridge?.emit(EVENT_NAME.twinnyExportConversation)
    ),
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
    // Kept alive while hidden, so a draft, a reply still streaming and the
    // scroll position survive switching to another view.
    window.registerWebviewViewProvider("twinny.sidebar", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
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
  void providerSetup.then(() => {
    statusBar.refresh()
    logStartup(context, startedAt)
    void teamNudge(context)
  })
}

/**
 * Once, after two weeks of use on a machine that is not connected to a team:
 * one message saying the gateway exists. Either button ends it for good; so
 * does dismissing it, since the date is recorded before it shows.
 */
const TEAM_NUDGE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
const teamNudge = async (context: ExtensionContext) => {
  const store = context.globalState
  const state = store.get<{ since: number; shown?: boolean }>(TEAM_NUDGE_STORAGE_KEY)
  if (!state) {
    await store.update(TEAM_NUDGE_STORAGE_KEY, { since: Date.now() })
    return
  }
  if (state.shown || Date.now() - state.since < TEAM_NUDGE_AFTER_MS) return
  if (new TeamPolicyStore(store).get()) return
  await store.update(TEAM_NUDGE_STORAGE_KEY, { ...state, shown: true })
  const choice = await window.showInformationMessage(
    "Twinny has been on this machine for a couple of weeks. Using it with a team? One command sets up a gateway with a key per developer, usage and policy; free for five.",
    "See how",
    "No thanks"
  )
  if (choice === "See how") void vscode.env.openExternal(vscode.Uri.parse(URL_TEAMS))
}

export function deactivate() {
  logger.info("Twinny deactivated")
}
