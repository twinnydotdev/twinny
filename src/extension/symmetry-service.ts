/* eslint-disable @typescript-eslint/no-explicit-any */
import { workspace, commands, WebviewView, ExtensionContext } from 'vscode'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'

import b4a from 'b4a'
import {
  createSymmetryMessage,
  safeParseJson,
  safeParseJsonResponse
} from './utils'
import { getChatDataFromProvider } from './utils'
import {
  StreamResponse,
  ServerMessage,
  Peer,
  SymmetryMessage,
  SymmetryConnection
} from '../common/types'
import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  EXTENSION_SESSION_NAME,
  SYMMETRY_EMITTER_KEY,
  SYMMETRY_DATA_MESSAGE
} from '../common/constants'
import { SessionManager } from './session-manager'
import { TwinnyProvider } from './provider-manager'
import { EventEmitter } from 'stream'

export class SymmetryService extends EventEmitter {
  private _config = workspace.getConfiguration('twinny')
  private view: WebviewView | undefined
  private _completion = ''
  private _providerSwarm: undefined | typeof Hyperswarm
  private _serverSwarm: undefined | typeof Hyperswarm
  private _sessionManager: SessionManager
  private _providerPeer: undefined | Peer
  private _serverPeer: undefined | Peer
  private _context: ExtensionContext
  private _providerTopic: Buffer | undefined
  private _emitterKey = ''

  constructor(
    view: WebviewView | undefined,
    sessionManager: SessionManager,
    context: ExtensionContext
  ) {
    super()
    this.view = view
    this._sessionManager = sessionManager
    this._providerSwarm
    this._providerPeer
    this._context = context
    this._providerTopic
  }

  public connect = async (key: string) => {
    this._serverSwarm = new Hyperswarm()
    const serverKey = Buffer.from(key)
    const discoveryKey = crypto.discoveryKey(serverKey)
    this._providerTopic = discoveryKey
    this._serverSwarm.join(this._providerTopic, { client: true, server: false })
    this._serverSwarm.flush()
    this._serverSwarm.on('connection', (peer: Peer) => {
      this._serverPeer = peer
      peer.write(
        createSymmetryMessage(SYMMETRY_DATA_MESSAGE.requestProvider, {
          modelName: this._config.symmetryModelName
        })
      )
      peer.on('data', (message: Buffer) => {
        const data = safeParseJson<SymmetryMessage<SymmetryConnection>>(
          message.toString()
        )
        if (data && data.key) {
          switch (data?.key) {
            case SYMMETRY_DATA_MESSAGE.ping:
              this._providerPeer?.write(createSymmetryMessage(SYMMETRY_DATA_MESSAGE.pong));
              break;
            case SYMMETRY_DATA_MESSAGE.providerDetails:
              peer.write(
                createSymmetryMessage(
                  SYMMETRY_DATA_MESSAGE.verifySession,
                  data.data?.sessionToken
                )
              )
              break
            case SYMMETRY_DATA_MESSAGE.sessionValid:
              this.connectToProvider(data.data)
          }
        }
      })
    })
  }

  public disconnect = async () => {
    this._sessionManager.set(
      EXTENSION_SESSION_NAME.twinnySymmetryConnected,
      false
    )
    this._serverSwarm?.destroy()
    this._providerSwarm?.destroy()
    this.view?.webview.postMessage({
      type: EVENT_NAME.twinnyDisconnectedFromSymmetry
    } as ServerMessage)
  }

  public connectToProvider = async (message: SymmetryConnection) => {
    this._providerSwarm = new Hyperswarm()
    this._providerSwarm.join(b4a.from(message.discoveryKey, 'hex'), {
      client: true,
      server: false
    })
    this._providerSwarm.flush()
    this._providerSwarm.on('connection', (peer: any) => {
      this._providerPeer = peer
      this.providerListeners(peer)
      this.view?.webview.postMessage({
        type: EVENT_NAME.twinnyConnectedToSymmetry,
        data: {
          modelName: message.modelName
        }
      })
      this._sessionManager?.set(
        EXTENSION_SESSION_NAME.twinnySymmetryConnected,
        true
      )
    })
    return this
  }

  private getProvider = () => {
    const provider = this._context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    return provider
  }

  private providerListeners = (peer: any) => {
    const provider = this.getProvider()
    if (!provider) return
    peer.on('data', (chunk: Buffer) => {
      const str = chunk.toString()
      if (str.includes('symmetryEmitterKey'))
        this._emitterKey = JSON.parse(str).symmetryEmitterKey

      if (!this._emitterKey) return

      if (str.includes(SYMMETRY_DATA_MESSAGE.inferenceEnd))
        this.handleInferenceEnd()

      this.handleIncomingData(chunk, (response: StreamResponse) => {
        const data = getChatDataFromProvider(provider.provider, response)
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
      this.view?.webview.postMessage({
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

  public write(message: string) {
    this._providerPeer?.write(message)
  }
}
