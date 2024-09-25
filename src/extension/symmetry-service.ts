/* eslint-disable @typescript-eslint/no-explicit-any */
import { workspace, commands, ExtensionContext, Webview } from 'vscode'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import { serverMessageKeys, SymmetryProvider } from 'symmetry-core'
import path from 'path'
import os from 'os'
import fs from 'fs'
import yaml from 'js-yaml'

import b4a from 'b4a'
import {
  createSymmetryMessage,
  safeParseJson,
  safeParseJsonResponse,
  updateSymmetryStatus
} from './utils'
import { getChatDataFromProvider } from './utils'
import {
  StreamResponse,
  ServerMessage,
  Peer,
  SymmetryMessage,
  SymmetryConnection,
  ClientMessage,
  SymmetryModelProvider
} from '../common/types'
import {
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  EXTENSION_SESSION_NAME,
  SYMMETRY_EMITTER_KEY,
  WEBUI_TABS,
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  GLOBAL_STORAGE_KEY
} from '../common/constants'
import { SessionManager } from './session-manager'
import { EventEmitter } from 'stream'
import { TwinnyProvider } from './provider-manager'
import { SymmetryWs } from './symmetry-ws'

export class SymmetryService extends EventEmitter {
  private _config = workspace.getConfiguration('twinny')
  private _completion = ''
  private _context: ExtensionContext
  private _emitterKey = ''
  private _provider: SymmetryProvider | undefined
  private _providerPeer: undefined | Peer
  private _providerSwarm: undefined | typeof Hyperswarm
  private _providerTopic: Buffer | undefined
  private _serverPeer: undefined | Peer
  private _serverSwarm: undefined | typeof Hyperswarm
  private _sessionManager: SessionManager | undefined
  private _symmetryProvider: string | undefined
  private _symmetryServerKey = this._config.symmetryServerKey
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
    this._providerSwarm
    this._providerPeer
    this._context = context
    this._providerTopic
    const autoConnectProvider = this._context.globalState.get(
      `${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.autoConnectSymmetryProvider}`
    )
    if (autoConnectProvider) this.startSymmetryProvider()

    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('twinny')) return
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
        [EVENT_NAME.twinnyStopSymmetryProvider]: this.stopSymmetryProvider,
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
    this._serverSwarm.on('connection', (peer: Peer) => {
      this._serverPeer = peer
      peer.write(
        createSymmetryMessage(serverMessageKeys.requestProvider, {
          modelName: model
        })
      )
      peer.on('data', (message: Buffer) => {
        const data = safeParseJson<SymmetryMessage<SymmetryConnection>>(
          message.toString()
        )
        if (data && data.key) {
          switch (data?.key) {
            case serverMessageKeys.ping:
              this._providerPeer?.write(
                createSymmetryMessage(serverMessageKeys.pong)
              )
              break
            case serverMessageKeys.providerDetails:
              peer.write(
                createSymmetryMessage(
                  serverMessageKeys.verifySession,
                  data.data?.sessionToken
                )
              )
              break
            case serverMessageKeys.sessionValid:
              this.connectToProvider(data.data)
          }
        }
      })
    })
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
    this._providerSwarm.join(b4a.from(connection.discoveryKey, 'hex'), {
      client: true,
      server: false
    })
    this._providerSwarm.flush()
    this._providerSwarm.on('connection', (peer: any) => {
      this._providerPeer = peer
      this.providerListeners(peer)
      this._webView?.postMessage({
        type: EVENT_NAME.twinnyConnectedToSymmetry,
        value: {
          data: {
            modelName: connection.modelName,
            name: connection.name,
            provider: connection.provider
          }
        }
      })
      this._webView?.postMessage({
        type: EVENT_NAME.twinnySetTab,
        value: {
          data: WEBUI_TABS.chat
        }
      })
      this._sessionManager?.set(
        EXTENSION_SESSION_NAME.twinnySymmetryConnection,
        connection
      )
      commands.executeCommand(
        'setContext',
        EXTENSION_CONTEXT_NAME.twinnySymmetryTab,
        false
      )
    })
    return this
  }

  private providerListeners = (peer: any) => {
    peer.on('data', (chunk: Buffer) => {
      const str = chunk.toString()
      if (str.includes('symmetryEmitterKey'))
        this._emitterKey = JSON.parse(str).symmetryEmitterKey

      if (!this._emitterKey) return

      if (str.includes(serverMessageKeys.inferenceEnded))
        this.handleInferenceEnd()

      this.handleIncomingData(chunk, (response: StreamResponse) => {
        if (!this._symmetryProvider) return
        const data = getChatDataFromProvider(this._symmetryProvider, response)
        this._completion = this._completion + data
        if (!data) return
        this.emit(this._emitterKey, this._completion)
      })
    })
  }

  private handleInferenceEnd() {
    commands.executeCommand(
      'setContext',
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      false
    )
    if (!this._completion) return

    if (this._emitterKey === SYMMETRY_EMITTER_KEY.inference) {
      this._webView?.postMessage({
        type: EVENT_NAME.twinnyOnEnd,
        value: {
          completion: this._completion.trimStart()
        }
      } as ServerMessage)
    }
    this._completion = ''
  }

  private handleIncomingData = (
    chunk: Buffer,
    cb: (data: StreamResponse) => void
  ) => {
    let buffer = ''
    buffer += chunk
    let position
    while ((position = buffer.indexOf('\n')) !== -1) {
      const line = buffer.substring(0, position)
      buffer = buffer.substring(position + 1)
      try {
        const json = safeParseJsonResponse(line)
        if (json) cb(json)
      } catch (e) {
        console.error('Error parsing JSON:', e)
      }
    }
  }

  public getChatProvider() {
    const provider = this._context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    return provider
  }

  private getSymmetryConfigPath(): string {
    const homeDir = os.homedir()
    return path.join(homeDir, '.config', 'symmetry', 'provider.yaml')
  }

  private createOrUpdateProviderConfig(providerConfig: TwinnyProvider): void {
    const configPath = this.getSymmetryConfigPath()
    const configDir = path.dirname(configPath)

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    const symmetryConfiguration = yaml.dump({
      apiHostname: providerConfig.apiHostname,
      apiKey: providerConfig.apiKey,
      apiPath: providerConfig.apiPath,
      apiPort: providerConfig.apiPort,
      apiProtocol: providerConfig.apiProtocol,
      apiProvider: providerConfig.provider,
      dataCollectionEnabled: false,
      maxConnections: 10,
      modelName: providerConfig.modelName,
      name: os.hostname(),
      path: configPath,
      public: true,
      serverKey: this._symmetryServerKey,
      systemMessage: ''
    })

    fs.writeFileSync(configPath, symmetryConfiguration, 'utf8')
  }

  public async startSymmetryProvider() {
    const providerConfig = this.getChatProvider()

    if (!providerConfig) return

    const configPath = this.getSymmetryConfigPath()

    if (!fs.existsSync(configPath)) {
      this.createOrUpdateProviderConfig(providerConfig)
    }

    this._provider = new SymmetryProvider(configPath)

    const sessionKey = EXTENSION_SESSION_NAME.twinnySymmetryConnectionProvider

    this._sessionManager?.set(sessionKey, 'connecting')

    const sessionTypeName = `${EVENT_NAME.twinnySessionContext}-${sessionKey}`

    this._webView?.postMessage({
      type: sessionTypeName,
      value: 'connecting'
    })

    await this._provider.init()

    this._sessionManager?.set(sessionKey, 'connected')

    this._webView?.postMessage({
      type: sessionTypeName,
      value: 'connected'
    })
  }

  public async stopSymmetryProvider() {
    await this._provider?.destroySwarms()
    updateSymmetryStatus(this._webView, 'disconnected')
    const sessionKey = EXTENSION_SESSION_NAME.twinnySymmetryConnectionProvider
    this._sessionManager?.set(sessionKey, 'disconnected')
  }

  public write(message: string) {
    this._providerPeer?.write(message)
  }

  private updateConfig() {
    this._config = workspace.getConfiguration('twinny')
    this._symmetryServerKey = this._config.symmetryServerKey
  }
}
