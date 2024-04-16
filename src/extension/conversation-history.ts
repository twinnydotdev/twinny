import { ExtensionContext, WebviewView, workspace } from 'vscode'
import {
  Conversation,
  Message,
  StreamBodyBase,
  StreamRequestOptions
} from '../common/types'
import { v4 as uuidv4 } from 'uuid'
import { createStreamRequestBody } from './provider-options'
import { ACTIVE_CHAT_PROVIDER_KEY, TwinnyProvider } from './provider-manager'
import { streamResponse } from './stream'
import { getChatDataFromProvider } from './utils'

type Conversations = Record<string, Conversation> | undefined

export const HISTORY_MESSAGE_TYPE = {
  saveConversation: 'twinny.save-conversation'
}

export const CONVERSATION_KEY = 'twinny.conversations'

export class ConversationHistory {
  _context: ExtensionContext
  _webviewView: WebviewView
  private _config = workspace.getConfiguration('twinny')
  private _keepAlive = this._config.get('keepAlive') as string | number
  private _temperature = this._config.get('temperature') as number
  private _title = ''

  constructor(context: ExtensionContext, webviewView: WebviewView) {
    this._context = context
    this._webviewView = webviewView
    this._context.globalState.update(CONVERSATION_KEY, {})
  }

  getConversations(): Conversations {
    const conversations =
      this._context.globalState.get<Record<string, Conversation>>(
        CONVERSATION_KEY
      )
    return conversations
  }

  streamConversationTitle({
    requestBody,
    requestOptions
  }: {
    requestBody: StreamBodyBase
    requestOptions: StreamRequestOptions
    onEnd?: (completion: string) => void
  }): Promise<string> {
    const provider = this.getProvider()

    if (!provider) return Promise.resolve('')

    return new Promise((resolve, reject) => {
      try {
        return streamResponse({
          body: requestBody,
          options: requestOptions,
          onData: (streamResponse) => {
            const data = getChatDataFromProvider(
              provider.provider,
              streamResponse
            )
            this._title = this._title + data
          },
          onEnd: () => {
            return resolve(this._title)
          }
        })
      } catch (e) {
        return reject(e)
      }
    })
  }

  private getProvider = () => {
    return this._context?.globalState.get<TwinnyProvider>(
      ACTIVE_CHAT_PROVIDER_KEY
    )
  }

  private buildStreamRequest(messages?: Message[]) {
    const provider = this.getProvider()

    if (!provider || !messages?.length) return

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

    const requestBody = createStreamRequestBody(provider.provider, '', {
      model: provider.modelName,
      numPredictChat: 100,
      temperature: this._temperature,
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            'Consider the history of this chat and generate a good title for it.'
        }
      ],
      keepAlive: this._keepAlive
    })

    return { requestOptions, requestBody }
  }

  async getConversationTitle(
    conversation: Message[],
    id: string
  ): Promise<string> {
    const request = this.buildStreamRequest(conversation)
    if (!request) return id
    return await this.streamConversationTitle(request)
  }

  async saveConversation(messages: Message[] | undefined) {
    const conversations = this.getConversations() || {}
    if (!messages?.length) return
    const id = uuidv4()
    const conversation: Conversation = {
      id,
      title: await this.getConversationTitle(messages, id),
      messages
    }
    conversations[conversation.id] = conversation
    this._context.globalState.update(CONVERSATION_KEY, conversations)
  }
}
