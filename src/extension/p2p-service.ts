/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from 'vscode'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Localdrive from 'localdrive'
import Corestore from 'corestore'
import b4a from 'b4a'
import path from 'path'
import os from 'os'
import { commands, WebviewView, workspace } from 'vscode'
import { safeParseJson, safeParseJsonResponse } from './utils'
import { getChatDataFromProvider, getLanguage } from './utils'
import { StreamResponse, ServerMessage, Peer } from '../common/types'
import {
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  serverMessageKeys
} from '../common/constants'

export class SymmetryService {
  // private store: typeof Corestore
  // private database: typeof Localdrive
  // private drive: typeof Hyperdrive
  // private swarm: typeof Hyperswarm
  private _config = vscode.workspace.getConfiguration('twinny')
  private view: WebviewView | undefined
  private localPath: string | undefined
  private _completion = ''
  private _providerSwarm: undefined | typeof Hyperswarm
  private _providerDatabase: undefined | typeof Localdrive
  private _providerDrive: undefined | typeof Hyperdrive
  private _providerStore: undefined | typeof Corestore
  private _discoveryKey: undefined | string

  constructor(view: WebviewView | undefined) {
    this.view = view
    this._providerSwarm
  }

  public connect = async (serverKey: string) => {
    if (!workspace.name) return
    const swarm = new Hyperswarm()
    swarm.join(b4a.from(serverKey, 'hex'), { client: true, server: false })
    swarm.flush()
    swarm.on('connection', (peer: Peer) => {
      peer.write(
        JSON.stringify({
          key: serverMessageKeys.requestProvider,
          data: {
            modelName: this._config.symmetryModelName
          }
        })
      )
      peer.on('data', (message: Buffer) => {
        const data = safeParseJson(message.toString())
        if (!data) return
        if (data.key) {
          switch (data?.key) {
            case serverMessageKeys.providerDetails:
              peer.write(
                JSON.stringify({
                  key: serverMessageKeys.verifySession,
                  data: {
                    sessionToken: data?.data?.sessionToken
                  }
                })
              )
              break
            case serverMessageKeys.sessionValid:
              this._discoveryKey = data?.data?.discoveryKey
              this.connectToProvider()
          }
        }
      })
    })
  }

  public connectToProvider = async () => {
    const homeDir = os.homedir()
    if (!workspace.name) return
    this.localPath = path.join(
      homeDir,
      '.twinny',
      'core',
      workspace.name,
      'local'
    )
    this._providerStore = new Corestore(
      homeDir,
      '.twinny',
      'core',
      workspace.name,
      'store'
    )
    // this._providerDatabase = new Localdrive(this.localPath)
    // this._providerDrive = new Hyperdrive(this._providerStore, key)
    this._providerSwarm = new Hyperswarm()
    if (!workspace.name) return
    // await this._providerDrive.ready()
    this._providerSwarm.join(b4a.from(this._discoveryKey, 'hex'), {
      client: true,
      server: false
    })
    this._providerSwarm.flush()
    this._providerSwarm.on('connection', (peer: any) => {
      this.providerHandlers(peer)
    })
    return this
  }

  public isConnectedToProvider() {
    return !!this._discoveryKey
  }

  private onEnd() {
    commands.executeCommand(
      'setContext',
      EXTENSION_CONTEXT_NAME.twinnyGeneratingText,
      false
    )
    if (!this._completion) return
    this.view?.webview.postMessage({
      type: EVENT_NAME.twinnyOnEnd,
      value: {
        completion: this._completion.trimStart(),
        data: getLanguage()
      }
    } as ServerMessage)
    this._completion = ''
  }

  private providerHandlers = (peer: any) => {
    peer.on('data', (chunk: Buffer) => {
      this.handleIncomingData(chunk, (response: StreamResponse) => {
        const data = getChatDataFromProvider('ollama', response)
        if (!data) return
        this._completion = this._completion + data
        this.view?.webview.postMessage({
          type: EVENT_NAME.twinnyOnCompletion,
          value: {
            completion: this._completion.trimStart(),
            data: getLanguage()
          }
        } as ServerMessage)
      })
    })

    // this._providerDrive.core.on('append', () => {
    //   this.sync()
    // })
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
      if (buffer.match('[DONE]')) {
        return this.onEnd()
      }
      try {
        const json = safeParseJsonResponse(line)
        if (json) cb(json)
      } catch (e) {
        console.error('Error parsing JSON:', e)
      }
    }
  }

  sync = async () => {
    await this._providerDrive.mirror(this._providerDatabase).done()
  }

  public request(messages: any) {
    const peers = [...this._providerSwarm.connections]
    for (const peer of peers) {
      const json = safeParseJsonResponse(JSON.stringify(messages))
      if (!json) return
      peer.write(JSON.stringify(json))
    }
  }

  disconnect = () => {
    this._providerSwarm.flush().then(() => this._providerStore.close())
    this._providerDatabase.close()
  }
}
