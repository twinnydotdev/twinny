import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { ExtensionContext, window, workspace } from "vscode"

import {
  DEFAULT_RELEVANT_CODE_COUNT,
  DEFAULT_RERANK_THRESHOLD,
  DEFAULT_WORKSPACE_CONTEXT_CHARS,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  TOP_LEVEL_MENTIONS,
  WORKSPACE_STORAGE_KEY
} from "../../common/constants"
import { CodeLanguageDetails } from "../../common/languages"
import { logger } from "../../common/logger"
import {
  AnyContextItem,
  MentionType,
  SelectionContextItem,
  TemplateData
} from "../../common/types"
import { Hit, WorkspaceSearch } from "../embeddings/search"
import { ExtensionBridge } from "../messaging/bridge"
import { TemplateProvider } from "../templates/provider"
import { NO_TERMINAL_OUTPUT, terminalHistory } from "../terminal"
import { formatTerminalRun } from "../terminal/output"
import { updateLoadingMessage } from "../utils"

import {
  ContextEntry,
  formatContextEntries,
  normalizeWorkspacePath
} from "./context-files"
import { getGitContext } from "./git-context"
import { getProblemsContext } from "./problems"
import { isSymbolRef } from "./symbol-ref"
import { readSymbolEntry } from "./symbols"

/**
 * Everything that goes into a prompt besides the user's own words: the
 * system prompt, the editor selection, `@workspace` / `@problems` / `@git` /
 * `@terminal` lookups, and the files and symbols the user attached or pinned.
 */
export class ChatContextBuilder {
  constructor(
    private readonly _context: ExtensionContext,
    private readonly _bridge: ExtensionBridge,
    private readonly _templates: TemplateProvider,
    private readonly _search: WorkspaceSearch | undefined
  ) {}

  private globalSetting<T>(key: string): T | undefined {
    return this._context.globalState.get<T>(
      `${EVENT_NAME.twinnyGlobalContext}-${key}`
    )
  }

  public async systemPrompt(): Promise<string> {
    return (
      (await this._templates.readTemplate<TemplateData>("system", {
        cwd: workspace.workspaceFolders?.[0].uri.fsPath,
        defaultShell: os.userInfo().shell,
        osName: os.platform(),
        homedir: os.homedir()
      })) || ""
    )
  }

  /** A code-action template (explain, refactor…) filled with the selection. */
  public async templatePrompt(
    template: string,
    language: CodeLanguageDetails,
    fallbackSelection?: string
  ) {
    const editor = window.activeTextEditor
    const selection =
      editor?.document.getText(editor.selection) || fallbackSelection || ""
    const prompt = await this._templates.readTemplate<TemplateData>(template, {
      code: selection,
      language: language?.langName || "unknown"
    })
    return { prompt: prompt || "", selection }
  }

  /** What `@workspace`, `@problems`, `@git` and `@terminal` pull in. */
  public async ragContext(text?: string): Promise<string | null> {
    let combined = ""

    if (text?.includes("@problems")) {
      const problems = getProblemsContext()
      if (problems) combined += `${problems}\n\n`
    }

    if (text?.includes("@git")) {
      const root = workspace.workspaceFolders?.[0]?.uri.fsPath
      const git = root ? await getGitContext(root) : undefined
      combined += `${git ?? "Git: the workspace is not a git repository."}\n\n`
    }

    if (text?.includes("@terminal")) {
      const run = terminalHistory.last()
      combined += `${run ? formatTerminalRun(run) : `Terminal: ${NO_TERMINAL_OUTPUT}`}\n\n`
    }

    const indexed = await this.workspaceContext(text)
    if (indexed) combined += `${indexed}\n\n`

    return combined.trim() || null
  }

  /**
   * What the index has to say about the message. Runs for `@workspace`, or
   * for every message when the user turned that on in the embeddings tab.
   * Nothing when there is no index yet, so the toggle is safe to leave on.
   */
  private async workspaceContext(text?: string): Promise<string | null> {
    if (!text || !this._search?.available) return null
    const mentioned = text.includes("@workspace")
    const automatic = this.globalSetting<boolean>(
      EXTENSION_CONTEXT_NAME.twinnyWorkspaceAutoContext
    )
    if (!mentioned && !automatic) return null

    updateLoadingMessage(this._bridge, "Searching the workspace")
    const query = text.replace(/@(workspace|problems|git|terminal)\b/g, " ").trim()
    const hits = await this._search.search(query, {
      limit:
        Number(this.globalSetting(EXTENSION_CONTEXT_NAME.twinnyRelevantCodeSnippets)) ||
        DEFAULT_RELEVANT_CODE_COUNT,
      threshold:
        Number(this.globalSetting(EXTENSION_CONTEXT_NAME.twinnyRerankThreshold)) ||
        DEFAULT_RERANK_THRESHOLD,
      maxChars: DEFAULT_WORKSPACE_CONTEXT_CHARS
    })
    if (!hits.length) return null

    logger.log(
      `@workspace: ${hits.length} hits\n${hits
        .map((hit) => `  ${hit.score.toFixed(2)} ${this.describeHit(hit)}`)
        .join("\n")}`
    )
    const code = formatContextEntries(
      hits.map((hit) => ({
        path: workspace.asRelativePath(hit.file),
        content: hit.content,
        range: { startLine: hit.startLine, endLine: hit.endLine }
      }))
    )
    return this._templates.readTemplate<TemplateData>("relevant-code", { code })
  }

  private describeHit(hit: Hit): string {
    return `${workspace.asRelativePath(hit.file)}:${hit.startLine + 1}-${hit.endLine + 1}`
  }

  /** The block appended to the user's last message. */
  public async additionalContext(
    message: string,
    mentions: MentionType[] = []
  ): Promise<string> {
    const editor = window.activeTextEditor
    const selection = editor?.document.getText(editor.selection)

    let context = selection ? `Selected Code:\n${selection}\n\n` : ""

    const rag = await this.ragContext(message)
    if (rag) context += `Additional Context:\n${rag}\n\n`

    const pinned =
      this._context.workspaceState.get<AnyContextItem[]>(
        WORKSPACE_STORAGE_KEY.contextItems
      ) || []
    const attached = formatContextEntries(
      await this.loadContextEntries(mentions, pinned)
    )
    if (attached) context += `Attached code:\n\n${attached}\n\n`

    return context
  }

  /** Everything the user attached: @mentions in the message, then pinned items. */
  private async loadContextEntries(
    mentions: MentionType[],
    items: AnyContextItem[]
  ): Promise<ContextEntry[]> {
    const entries: ContextEntry[] = []

    for (const mention of mentions) {
      if (!mention.path || TOP_LEVEL_MENTIONS.has(mention.path)) continue
      if (isSymbolRef(mention.path)) {
        const entry = await readSymbolEntry(mention.path)
        if (entry) entries.push(entry)
        continue
      }
      const mentionPath = normalizeWorkspacePath(mention.path)
      const content = await this.readWorkspaceFile(mentionPath)
      if (content !== undefined) entries.push({ path: mentionPath, content })
    }

    for (const item of items) {
      if (item.category === "selection" && "selectionRange" in item) {
        entries.push(await this.loadSelectionEntry(item))
      } else if (item.category === "files" && item.path) {
        const content = await this.readWorkspaceFile(item.path)
        if (content !== undefined) entries.push({ path: item.path, content })
      }
    }

    return entries
  }

  /**
   * A pinned selection follows the file: re-read the lines it covers so the
   * model sees what is there now, and fall back to the snapshot taken when
   * it was pinned if the file has gone.
   */
  private async loadSelectionEntry(
    item: SelectionContextItem
  ): Promise<ContextEntry> {
    const { startLine, endLine } = item.selectionRange
    const range = { startLine, endLine }
    const text = await this.readWorkspaceFile(item.path)
    const lines = text?.split("\n")
    if (!lines || endLine >= lines.length) {
      return { path: item.path, content: item.content, range }
    }
    return {
      path: item.path,
      content: lines.slice(startLine, endLine + 1).join("\n"),
      range
    }
  }

  /**
   * Current text of a workspace file: the editor buffer when it is open (so
   * unsaved edits count), otherwise the file on disk. The path is resolved
   * against the workspace root first; a path that only makes sense as an
   * absolute one (a file outside the workspace) is tried as-is after that.
   */
  private async readWorkspaceFile(
    filePath: string
  ): Promise<string | undefined> {
    const root = workspace.workspaceFolders?.[0]?.uri.fsPath
    const relative = normalizeWorkspacePath(filePath)
    const candidates = [
      ...(root ? [path.join(root, relative)] : []),
      ...(path.isAbsolute(filePath) ? [filePath] : [])
    ]
    if (!candidates.length) return undefined

    for (const fullPath of candidates) {
      const open = workspace.textDocuments.find(
        (document) => document.uri.fsPath === fullPath
      )
      if (open) return open.getText()
    }

    let lastError: unknown
    for (const fullPath of candidates) {
      try {
        return await fs.readFile(fullPath, "utf-8")
      } catch (error) {
        lastError = error
      }
    }
    logger.error(`Could not read context file ${filePath}: ${lastError}`)
    return undefined
  }
}
