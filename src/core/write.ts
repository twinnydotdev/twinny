/* eslint-disable @typescript-eslint/no-explicit-any */
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Localdrive from 'localdrive'
import Corestore from 'corestore'
import path from 'path'
import { writeFileSync } from 'fs'
import { StreamRequestOptions, StreamResponse } from '../common/types'
import { ExtensionContext } from 'vscode'
import { ACTIVE_CHAT_PROVIDER_STORAGE_KEY, USER } from '../common/constants'
import { createStreamRequestBody } from '../extension/provider-options'
import { TwinnyProvider } from '../extension/provider-manager'
import { streamResponse } from '../extension/stream'
import {
  getChatDataFromProvider,
  safeParseJsonStringBuffer
} from '../extension/utils'

export class CoreWriter {
  store: typeof Corestore
  local: typeof Localdrive
  drive: typeof Hyperdrive
  swarm: typeof Hyperswarm
  localPath = path.join(__dirname, 'core', 'write-dir')
  mirror: any
  _extensionContext?: ExtensionContext
  _numPredictChat = 10
  _temperature = 0.5
  _keepAlive = false
  _messageIndex = 0
  _completion = ''

  constructor(context: ExtensionContext) {
    this.store = new Corestore(path.join(__dirname, 'core', 'write'))
    this.local = new Localdrive(this.localPath)
    this.drive = new Hyperdrive(this.store)
    this.swarm = new Hyperswarm()
    this._extensionContext = context
  }

  init = async () => {
    await this.drive.ready()
    await this.sync()
    const discovery = this.swarm.join(this.drive.discoveryKey)
    await discovery.flushed()
    this.swarm.on('connection', (peer: any) => {
      this.store.replicate(peer)
      this.listeners(peer)
    })
  }

  listeners(peer: any) {
    peer.on('data', (buffer: Buffer) => {
      console.log(buffer.toString())
      const json = safeParseJsonStringBuffer(buffer.toString()) as {
        message: string
      }
      if (json) {
        const { message } = json
        this.request(message)
      }
    })
  }

  private getProvider = () => {
    const provider = this._extensionContext?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_STORAGE_KEY
    )
    return provider
  }

  private buildStreamRequest(prompt: string) {
    const message = {
      role: USER,
      content: prompt
    }

    const provider = this.getProvider()

    if (!provider) return

    const requestOptions: StreamRequestOptions = {
      hostname: provider.apiHostname,
      port: Number(provider.apiPort),
      path: provider.apiPath,
      protocol: provider.apiProtocol,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      }
    }

    const requestBody = createStreamRequestBody(provider.provider, {
      model: provider.modelName,
      numPredictChat: this._numPredictChat,
      temperature: this._temperature,
      messages: [message] || undefined
    })

    return { requestOptions, requestBody }
  }

  request(prompt?: string) {
    if (!prompt) return

    const req = this.buildStreamRequest(prompt)

    if (!req) return

    const { requestOptions, requestBody } = req

    const filePath = path.join(this.localPath, 'chat.txt')

    streamResponse({
      body: requestBody,
      options: requestOptions,
      onData: (streamResponse) => {
        const provider = this.getProvider()
        if (!provider) return

        try {
          const data = getChatDataFromProvider(
            provider.provider,
            streamResponse as StreamResponse
          )

          this._completion = this._completion + data

          writeFileSync(filePath, this._completion)

          this.sync()
        } catch (error) {
          console.error('Error parsing JSON:', error)
          return
        }
      },
      onEnd: () => {
        this._completion = ''
      }
    })
  }

  async sync() {
    await this.local.mirror(this.drive).done()
  }

  public getDrive() {
    return this.drive
  }
}
