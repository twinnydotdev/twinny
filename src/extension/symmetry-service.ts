/* eslint-disable @typescript-eslint/no-explicit-any */
import b4a from "b4a"
import fs from "fs"
import crypto from "hypercore-crypto"
import Hyperswarm from "hyperswarm"
import yaml from "js-yaml"
import os from "os"
import path from "path"
import { EventEmitter } from "stream"
import {
  ProviderConfig,
  serverMessageKeys,
  SymmetryClient
} from "symmetry-core"
import { commands, ExtensionContext, Webview, workspace } from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ASSISTANT,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  EXTENSION_SESSION_NAME,
  GLOBAL_STORAGE_KEY,
  SYMMETRY_EMITTER_KEY,
  WEBUI_TABS
} from "../common/constants"
import {
  ChatCompletionMessage,
  ClientMessage,
  Peer,
  ServerMessage,
  SymmetryConnection,
  SymmetryMessage,
  SymmetryModelProvider
} from "../common/types"

import { TwinnyProvider } from "./provider-manager"
import { SessionManager } from "./session-manager"
import { SymmetryWs } from "./symmetry-ws"
import {
  createSymmetryMessage,
  safeParseJson,
  updateSymmetryStatus
} from "./utils"

export class SymmetryService extends EventEmitter {
  private _config = workspace.getConfiguration("twinny")
  private _completion = ""
  private _context: ExtensionContext
  private _client: SymmetryClient | undefined
  private _providerPeer: undefined | Peer
  private _providerSwarm: undefined | typeof Hyperswarm
  private _providerTopic: Buffer | undefined
  private _serverPeer: undefined | Peer
  private _serverSwarm: undefined | typeof Hyperswarm
  private _sessionManager: SessionManager | undefined
  private _symmetryProvider: string | undefined
  private _webView: Webview | undefined
  private _ws: SymmetryWs | undefined

  constructor(
    webView: Webview | undefined,
    sessionManager: SessionManager | undefined,
    context: ExtensionContext
  ) {
    super()
    this._webView = webView
    this._sessionManager = sessionManager
    this._context = context
    const autoConnectProvider = this._context.globalState.get(
      `${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.autoConnectSymmetryProvider}`
    )
    if (autoConnectProvider) this.startSymmetryProvider()

    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("twinny")) return
      this.updateConfig()
    })

    this._ws = new SymmetryWs(this._webView)
    this._ws.connectSymmetryWs()
    this.setupEventListeners()
  }

  private setupEventListeners() {
    this._webView?.onDidReceiveMessage((message) => {
      const eventHandlers = {
        [EVENT_NAME.twinnyConnectSymmetry]: this.connect,
        [EVENT_NAME.twinnyDisconnectSymmetry]: this.disconnect,
        [EVENT_NAME.twinnyStartSymmetryProvider]: this.startSymmetryProvider,
        [EVENT_NAME.twinnyStopSymmetryProvider]: this.stopSymmetryProvider
      }
      eventHandlers[message.type as string]?.(message)
    })
  }

  public connect = async (data: ClientMessage<SymmetryModelProvider>) => {
    const key = this._config.symmetryServerKey
    const model = data.data?.model_name
    if (!data.data?.model_name || !key) return
    this._symmetryProvider = data.data.provider
    this._serverSwarm = new Hyperswarm()
    const serverKey = Buffer.from(key)
    const discoveryKey = crypto.discoveryKey(serverKey)
    this._providerTopic = discoveryKey
    this._serverSwarm.join(this._providerTopic, { client: true, server: false })
    this._serverSwarm.flush()
    this._serverSwarm.on("connection", (peer: Peer) =>
      this.handleServerConnection(peer, model)
    )
  }

  private handleServerConnection = (peer: Peer, model: string | undefined) => {
    this._serverPeer = peer
    peer.write(
      createSymmetryMessage(serverMessageKeys.requestProvider, {
        modelName: model
      })
    )
    peer.on("data", this.handleServerData)
  }

  private handleServerData = (message: Buffer) => {
    const data = safeParseJson<SymmetryMessage<SymmetryConnection>>(
      message.toString()
    )
    if (!data || !data.key) return

    switch (data.key) {
      case serverMessageKeys.providerDetails:
        this._serverPeer?.write(
          createSymmetryMessage(
            serverMessageKeys.verifySession,
            data.data?.sessionToken
          )
        )
        break
      case serverMessageKeys.sessionValid:
        this.connectToProvider(data.data)
        break
    }
  }

  public disconnect = async () => {
    this._sessionManager?.set(
      EXTENSION_SESSION_NAME.twinnySymmetryConnection,
      undefined
    )
    this._serverSwarm?.destroy()
    this._providerSwarm?.destroy()
    this._webView?.postMessage({
      type: EVENT_NAME.twinnyDisconnectedFromSymmetry
    } as ServerMessage)
  }

  public connectToProvider = async (connection: SymmetryConnection) => {
    this._providerSwarm = new Hyperswarm()
    this._providerSwarm.join(b4a.from(connection.discoveryKey, "hex"), {
      client: true,
      server: false
    })
    this._providerSwarm.flush()
    this._providerSwarm.on("connection", (peer: any) =>
      this.handleProviderConnection(peer, connection)
    )
  }

  private handleProviderConnection(peer: Peer, connection: SymmetryConnection) {
    this._providerPeer = peer
    this.setupProviderListeners(peer)
    this.notifyWebView(EVENT_NAME.twinnyConnectedToSymmetry, {
      modelName: connection.modelName,
      name: connection.name,
      provider: connection.provider
    })
    this.notifyWebView(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
    this._sessionManager?.set(
      EXTENSION_SESSION_NAME.twinnySymmetryConnection,
      connection
    )
    commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnySymmetryTab,
      false
    )
  }

  private setupProviderListeners(peer: Peer) {
    peer.on("data", (chunk: Buffer) => {
      const response = chunk.toString()
      if (response.includes(serverMessageKeys.inferenceEnded)) {
        this.handleInferenceEnd()
        return
      }
      this._completion += response
      if (this._completion) this.emit(SYMMETRY_EMITTER_KEY.inference, this._completion)
    })
  }

  private handleInferenceEnd() {
    commands.executeCommand(
      "setContext",
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      false
    )
    if (!this._completion) return

    this._webView?.postMessage({
      type: EVENT_NAME.twinnyAddMessage,
      data: {
        role: ASSISTANT,
        content: this._completion.trimStart()
      }
    } as ServerMessage<ChatCompletionMessage>)

    this._webView?.postMessage({
      type: EVENT_NAME.twinnyStopGeneration
    } as ServerMessage<ChatCompletionMessage>)
    this._completion = ""
  }

  private getSymmetryConfigPath(): string {
    const homeDir = os.homedir()
    return path.join(homeDir, ".config", "symmetry", "provider.yaml")
  }

  private createProviderConfig(provider: TwinnyProvider): ProviderConfig {
    const configPath = this.getSymmetryConfigPath()
    const configDir = path.dirname(configPath)

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    const config: ProviderConfig = {
      apiHostname: provider.apiHostname || "localhost",
      apiKey: provider.apiKey,
      apiBasePath: provider.apiPath,
      apiChatPath: provider.apiPath,
      dataPath: configDir,
      apiPort: provider.apiPort || 8080,
      apiProtocol: provider.apiProtocol || "http",
      apiProvider: provider.provider,
      dataCollectionEnabled: false,
      maxConnections: 10,
      modelName: provider.modelName,
      name: os.hostname(),
      public: true,
      serverKey: this._config.symmetryServerKey,
      systemMessage: "",
      userSecret: ""
    }

    const symmetryConfiguration = yaml.dump(config)

    fs.promises.writeFile(configPath, symmetryConfiguration, "utf8")

    return config
  }

  private async readProviderConfig(): Promise<ProviderConfig> {
    const configPath = this.getSymmetryConfigPath()
    const configStr = await fs.promises.readFile(configPath, "utf8")
    return yaml.load(configStr) as ProviderConfig
  }

  private updateProviderConfig = async (
    provider: TwinnyProvider
  ): Promise<void> => {
    const configPath = this.getSymmetryConfigPath()
    const configDir = path.dirname(configPath)

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    try {
      if (fs.existsSync(configPath)) {
        const backupPath = `${configPath}.backup-${Date.now()}`
        await fs.promises.copyFile(configPath, backupPath)
      }

      let config: ProviderConfig
      if (fs.existsSync(configPath)) {
        config = await this.readProviderConfig()
        const updates: Partial<ProviderConfig> = {}
        if (!config.apiChatPath) updates.apiChatPath = provider.apiPath
        if (!config.dataPath) updates.dataPath = configDir

        const updatedConfig = { ...config, ...updates }
        await fs.promises.writeFile(
          configPath,
          yaml.dump(updatedConfig),
          "utf8"
        )
      } else {
        config = this.createProviderConfig(
          this.getChatProvider() as TwinnyProvider
        )
        await fs.promises.writeFile(configPath, yaml.dump(config), "utf8")
      }
    } catch (error) {
      console.error("Failed to update config:", error)
      throw error
    }
  }

  public startSymmetryProvider = async () => {
    const provider = this.getChatProvider()
    if (!provider) return

    try {
      await this.updateProviderConfig(provider)

      this._client = new SymmetryClient(this.getSymmetryConfigPath())

      const sessionKey = EXTENSION_SESSION_NAME.twinnySymmetryConnectionProvider
      this._sessionManager?.set(sessionKey, "connecting")

      const sessionTypeName = `${EVENT_NAME.twinnySessionContext}-${sessionKey}`
      this._webView?.postMessage({
        type: sessionTypeName,
        data: "connecting"
      })

      await this._client.init()

      this._sessionManager?.set(sessionKey, "connected")
      this._webView?.postMessage({
        type: sessionTypeName,
        data: "connected"
      })
    } catch (error) {
      console.error("Failed to start provider:", error)
      this._sessionManager?.set(
        EXTENSION_SESSION_NAME.twinnySymmetryConnectionProvider,
        "error"
      )
    }
  }

  private notifyWebView(type: string, data: any = {}) {
    this._webView?.postMessage({ type, data })
  }

  public getChatProvider() {
    const provider = this._context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    return provider
  }

  public stopSymmetryProvider = async () => {
    await this._client?.destroySwarms()
    updateSymmetryStatus(this._webView, "disconnected")
    const sessionKey = EXTENSION_SESSION_NAME.twinnySymmetryConnectionProvider
    this._sessionManager?.set(sessionKey, "disconnected")
  }

  public write(message: string) {
    this._providerPeer?.write(message)
  }

  private updateConfig() {
    this._config = workspace.getConfiguration("twinny")
  }
}
