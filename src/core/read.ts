/* eslint-disable @typescript-eslint/no-explicit-any */
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Localdrive from 'localdrive'
import Corestore from 'corestore'
import b4a from 'b4a'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { WebviewView, workspace } from 'vscode'
import { getLanguage } from '../extension/utils'
import { EVENT_NAME } from '../common/constants'
import { ServerMessage } from '../common/types'

export class CoreReader {
  store: typeof Corestore
  database: typeof Localdrive
  drive: typeof Hyperdrive
  swarm: typeof Hyperswarm
  mirror: any
  view: WebviewView
  chatFile: string | undefined

  constructor(view: WebviewView) {
    this.view = view
    const homeDir = os.homedir()
    const workspaceName = workspace.name
    if (!workspaceName) return
    this.chatFile = path.join(homeDir, '.twinny', 'core', workspaceName, 'dir')
    this.store = new Corestore(path.join(__dirname, 'core', 'read'))
    this.database = new Localdrive(this.chatFile)
    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (conn: any) => {
      this.store.replicate(conn)
    })
  }

  async init(key: string, discoveryKey: string) {
    this.drive = new Hyperdrive(this.store, key)
    await this.drive.ready()
    this.swarm.join(b4a.from(discoveryKey, 'hex'), { client: true, server: false })
    this.swarm.flush().then(() => this.store.findingPeers())
    this.listeners()
  }

  listeners() {
    this.drive.core.on('append', () => this.sync())

  }

  public read(prompt: string) {
    const peers = [...this.swarm.connections]
    for (const peer of peers) {
      peer.write(`{"message": "${prompt}"}`)
    }
  }

  async sync() {
    await this.drive.mirror(this.database).done()
    const content = fs.readFileSync(`${this.chatFile}/chat.txt`, 'utf8')
    this.view?.webview.postMessage({
      type: EVENT_NAME.twinnyOnCompletion,
      value: {
        completion: content,
        data: getLanguage(),
      }
    } as ServerMessage)
  }
}
