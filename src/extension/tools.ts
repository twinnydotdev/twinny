import * as path from "path"
import { TextEncoder } from "util"
import * as vscode from "vscode"

import { EVENT_NAME, TOOL_EVENT_NAME } from "../common/constants"
import { ClientMessage, Message, ServerMessage, Tool } from "../common/types"

import { Base } from "./base"

interface CreateFileArgs {
  path: string
  content: string
  openAfterCreate?: boolean
  createIntermediateDirs?: boolean
  fileTemplate?: string
  permissions?: string
}

interface RunCommandArgs {
  command: string
  cwd?: string
  env?: Record<string, string>
  shell?: string
  timeout?: number
  captureOutput?: boolean
  runInBackground?: boolean
}

interface OpenFileArgs {
  path: string
  preview?: boolean
  viewColumn?: "beside" | "active" | "new"
  encoding?: string
  revealIfOpen?: boolean
}

interface EditFileArgs {
  path: string
  edit: string
  createIfNotExists?: boolean
  backupBeforeEdit?: boolean
}

export class Tools extends Base {
  private _workspaceRoot: string | undefined
  private webView: vscode.Webview

  constructor(webView: vscode.Webview, context: vscode.ExtensionContext) {
    super(context)
    this.webView = webView
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders) this._workspaceRoot = workspaceFolders[0].uri.fsPath
    this.setUpEventListeners()
  }

  setUpEventListeners() {
    this.webView?.onDidReceiveMessage((message: ClientMessage<Message>) => {
      this.handleMessage(message)
    })
  }

  public async rejectTool(call: Tool, message: Message): Promise<void> {
    if (message.tools && message.tools[call.name]) {
      message.tools[call.name].status = "rejected"
    }

    this.webView?.postMessage({
      type: EVENT_NAME.twinnyOnCompletionEnd,
      data: message
    } as ServerMessage<Message>)
  }

  public async runTool(call: Tool, message?: Message): Promise<string> {
    const method = this?.[call.name as keyof Tools]
    if (method && typeof method === "function") {
      if (message?.tools && message.tools[call.name]) {
        message.tools[call.name].status = "running"
        this.webView?.postMessage({
          type: EVENT_NAME.twinnyOnCompletionEnd,
          data: message
        } as ServerMessage<Message>)
      }

      const boundMethod = method.bind(this) as (
        args: unknown
      ) => Promise<string>
      const result = await boundMethod(call.arguments)
      if (message?.tools && message.tools[call.name]) {
        message.tools[call.name].status = "success"
        this.webView?.postMessage({
          type: EVENT_NAME.twinnyOnCompletionEnd,
          data: message
        } as ServerMessage<Message>)
      }

      return result
    }

    return ""
  }

  private async runAllTools(message: Message | undefined) {
    if (!message?.tools) return

    for (const [toolName, tool] of Object.entries(message.tools)) {
      try {
        message.tools[toolName].status = "running"
        this.webView?.postMessage({
          type: EVENT_NAME.twinnyOnCompletionEnd,
          data: message
        } as ServerMessage<Message>)

        await this.runTool(tool, message)
      } catch (error: unknown) {
        if (error instanceof Error && message.tools[toolName]) {
          message.tools[toolName].error = error.message
          message.tools[toolName].status = "error"
          this.webView?.postMessage({
            type: EVENT_NAME.twinnyOnCompletionEnd,
            data: message
          } as ServerMessage<Message>)
        }
      }
    }
  }

  async handleMessage(
    message: ClientMessage<Message | { message: Message; tool: Tool }>
  ) {
    const { type } = message
    switch (type) {
      case TOOL_EVENT_NAME.runAllTools:
        return await this.runAllTools(message.data as Message)

      case TOOL_EVENT_NAME.runTool: {
        const data = message.data as { message: Message; tool: Tool }
        try {
          await this.runTool(data.tool, data.message)
        } catch (error: unknown) {
          if (error instanceof Error) {
            const tools = data.message.tools
            if (!tools) return
            tools[data.tool.name].error = error.message
            tools[data.tool.name].status = "error"
            this.webView?.postMessage({
              type: EVENT_NAME.twinnyOnCompletionEnd,
              data: data.message
            } as ServerMessage<Message>)
          }
        }
        return
      }

      case TOOL_EVENT_NAME.rejectTool: {
        const data = message.data as { message: Message; tool: Tool }
        await this.rejectTool(data.tool, data.message)
        return
      }
    }
  }

  async createFile(args: CreateFileArgs): Promise<string> {
    const {
      path: filePath,
      content,
      openAfterCreate = false,
      createIntermediateDirs,
      fileTemplate
    } = args
    const fullPath = path.join(this._workspaceRoot || "", filePath)
    const uri = vscode.Uri.file(fullPath)

    const finalContent = fileTemplate ? `${fileTemplate}\n${content}` : content

    try {
      if (createIntermediateDirs) {
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.file(path.dirname(fullPath))
        )
      }

      const ws = new vscode.WorkspaceEdit()
      ws.createFile(uri, { overwrite: false })
      await vscode.workspace.applyEdit(ws)

      const enc = new TextEncoder()
      await vscode.workspace.fs.writeFile(uri, enc.encode(finalContent))

      if (openAfterCreate) {
        const doc = await vscode.workspace.openTextDocument(uri)
        await vscode.window.showTextDocument(doc)
      }

      return `File created successfully at ${fullPath}`
    } catch (error) {
      throw new Error(
        `Failed to create file: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  async runCommand(args: RunCommandArgs): Promise<string> {
    const {
      command,
      cwd = this._workspaceRoot,
      env,
      shell,
      timeout,
      runInBackground
    } = args

    return new Promise((resolve, reject) => {
      const terminal = vscode.window.createTerminal({
        name: "Extension Command",
        cwd: cwd,
        env: env,
        shellPath: shell
      })

      if (timeout) {
        setTimeout(() => {
          reject(new Error("Command timed out"))
        }, timeout)
      }

      terminal.sendText(command, true)

      if (!runInBackground) {
        terminal.show()
      }

      resolve("Command executed successfully!")
    })
  }

  async openFile(args: OpenFileArgs): Promise<string> {
    const {
      path: filePath,
      preview = false,
      viewColumn = "active",
    } = args
    const fullPath = path.join(this._workspaceRoot || "", filePath)
    const uri = vscode.Uri.file(fullPath)

    try {
      const doc = await vscode.workspace.openTextDocument(uri)
      let column: vscode.ViewColumn | undefined = vscode.ViewColumn.Active
      if (viewColumn === "beside") {
        column = vscode.ViewColumn.Beside
      } else if (viewColumn === "new") {
        column = vscode.ViewColumn.Active
      }

      await vscode.window.showTextDocument(doc, {
        preview,
        viewColumn: column
      })

      return `File opened successfully: ${fullPath}`
    } catch (error) {
      throw new Error(
        `Failed to open file: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  async editFile(args: EditFileArgs): Promise<string> {
    const {
      path: filePath,
      createIfNotExists = true,
      backupBeforeEdit = false,
      edit
    } = args
    const fullPath = path.join(this._workspaceRoot || "", filePath)
    const uri = vscode.Uri.file(fullPath)

    try {
      let fileExists = true
      try {
        await vscode.workspace.fs.stat(uri)
      } catch {
        fileExists = false
      }

      if (!fileExists) {
        if (createIfNotExists) {
          const ws = new vscode.WorkspaceEdit()
          ws.createFile(uri, { overwrite: false })
          await vscode.workspace.applyEdit(ws)
        } else {
          throw new Error(`File does not exist: ${fullPath}`)
        }
      }

      if (backupBeforeEdit && fileExists) {
        const backupUri = vscode.Uri.file(fullPath + ".bak")
        const data = await vscode.workspace.fs.readFile(uri)
        await vscode.workspace.fs.writeFile(backupUri, data)
      }

      const doc = await vscode.workspace.openTextDocument(uri)
      const entireRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      )

      const ws = new vscode.WorkspaceEdit()
      ws.replace(uri, entireRange, edit)

      await vscode.workspace.applyEdit(ws)
      await doc.save()

      return `File edited successfully: ${fullPath}`
    } catch (error) {
      throw new Error(
        `Failed to edit file: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}
