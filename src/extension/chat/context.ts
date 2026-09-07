import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { ExtensionContext, window, workspace } from "vscode"

import { WORKSPACE_STORAGE_KEY } from "../../common/constants"
import { CodeLanguageDetails } from "../../common/languages"
import { logger } from "../../common/logger"
import {
  AnyContextItem,
  MentionType,
  SelectionContextItem,
  TemplateData
} from "../../common/types"
import { ExtensionBridge } from "../messaging/bridge"
import { TemplateProvider } from "../templates/provider"
import { updateLoadingMessage } from "../utils"

import {
  ContextEntry,
  formatContextEntries,
  normalizeWorkspacePath
} from "./context-files"
import { getProblemsContext } from "./problems"
import { WorkspaceSearch } from "./workspace-search"

/**
 * Everything that goes into a prompt besides the user's own words: the
 * system prompt, the editor selection, `@workspace` / `@problems` lookups,
 * and the files the user attached or pinned.
 */
export class ChatContextBuilder {
  constructor(
    private readonly _context: ExtensionContext,
    private readonly _bridge: ExtensionBridge,
    private readonly _templates: TemplateProvider,
    private readonly _search: WorkspaceSearch
  ) {}

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

  /** What `@workspace` and `@problems` in the message pull in. */
  public async ragContext(text?: string): Promise<string | null> {
    let combined = ""

    if (text?.includes("@problems")) {
      const problems = getProblemsContext()
      if (problems) combined += `${problems}\n\n`
    }

    if (text?.includes("@workspace")) {
      updateLoadingMessage(this._bridge, "Exploring knowledge base")
      const query = text.replace(/@workspace|@problems/g, "")
      const files = await this._search.relevantFiles(query)
      const code = await this._search.relevantCode(query, files)

      if (files.length) {
        const filesTemplate = await this._templates.readTemplate<TemplateData>(
          "relevant-files",
          { code: files.map(([file]) => file).join(", ") }
        )
        combined += `${filesTemplate}\n\n`
      }
      if (code) {
        combined += await this._templates.readTemplate<TemplateData>(
          "relevant-code",
          { code }
        )
      }
    }

    return combined.trim() || null
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
      if (!mention.path) continue
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
