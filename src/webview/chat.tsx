import { useEffect, useRef, useState } from 'react'

import {
  VSCodeButton,
  VSCodeTextArea,
  VSCodePanelView,
  VSCodeProgressRing,
  VSCodeBadge,
  VSCodeDropdown,
  VSCodeOption,
  VSCodeDivider
} from '@vscode/webview-ui-toolkit/react'

import { ASSISTANT, MESSAGE_KEY, MESSAGE_NAME, USER } from '../common/constants'

import {
  useProviders,
  useSelection,
  useTheme,
  useWorkSpaceContext
} from './hooks'
import { DisabledAutoScrollIcon, EnabledAutoScrollIcon } from './icons'

import { Suggestions } from './suggestions'
import { ClientMessage, MessageType, ServerMessage } from '../common/types'
import { Message } from './message'
import { getCompletionContent, getModelShortName } from './utils'
import styles from './index.module.css'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const global = globalThis as any
export const Chat = () => {
  const [inputText, setInputText] = useState('')
  const {
    getFimProvidersByType,
    setActiveChatProvider,
    setActiveFimProvider,
    providers,
    chatProvider,
    fimProvider
  } = useProviders()
  const generatingRef = useRef(false)
  const stopRef = useRef(false)
  const theme = useTheme()
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<MessageType[] | undefined>()
  const [completion, setCompletion] = useState<MessageType | null>()
  const markdownRef = useRef<HTMLDivElement>(null)
  const autoScrollContext = useWorkSpaceContext<boolean>(MESSAGE_KEY.autoScroll)
  const showProvidersContext = useWorkSpaceContext<boolean>(
    MESSAGE_KEY.showProviders
  )
  const [showProviders, setShowProviders] = useState<boolean | undefined>(
    showProvidersContext || false
  )
  const [isAutoScrolledEnabled, setIsAutoScrolledEnabled] = useState<
    boolean | undefined
  >(autoScrollContext)
  const lastConversation = useWorkSpaceContext<MessageType[]>(
    MESSAGE_KEY.lastConversation
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chatRef = useRef<any>(null) // TODO: type...

  const scrollBottom = () => {
    if (!isAutoScrolledEnabled) return
    setTimeout(() => {
      if (markdownRef.current) {
        markdownRef.current.scrollTop = markdownRef.current.scrollHeight
      }
    }, 200)
  }

  const selection = useSelection(scrollBottom)

  const handleCompletionEnd = (message: ServerMessage) => {
    if (message.value) {
      setMessages((prev) => {
        const update = [
          ...(prev || []),
          {
            role: ASSISTANT,
            content: getCompletionContent(message)
          }
        ]
        global.vscode.postMessage({
          type: MESSAGE_NAME.twinnySetWorkspaceContext,
          key: MESSAGE_KEY.lastConversation,
          data: update
        } as ClientMessage<MessageType[]>)
        return update
      })
      setTimeout(() => {
        chatRef.current?.focus()
        stopRef.current = false
      }, 200)
    }
    setCompletion(null)
    setLoading(false)
    generatingRef.current = false
  }

  const handleAddTemplateMessage = (message: ServerMessage) => {
    if (stopRef.current) {
      generatingRef.current = false
      return
    }
    generatingRef.current = true
    setLoading(false)
    if (isAutoScrolledEnabled) scrollBottom()
    setMessages((prev) => [
      ...(prev || []),
      {
        role: USER,
        content: message.value.completion as string
      }
    ])
  }

  const handleCompletionMessage = (message: ServerMessage) => {
    if (stopRef.current) {
      generatingRef.current = false
      return
    }
    generatingRef.current = true
    setLoading(false)
    setCompletion({
      role: ASSISTANT,
      content: getCompletionContent(message),
      type: message.value.type,
      language: message.value.data,
      error: message.value.error
    })
    if (isAutoScrolledEnabled) scrollBottom()
  }

  const handleLoadingMessage = () => {
    setLoading(true)
    if (isAutoScrolledEnabled) scrollBottom()
  }

  const messageEventHandler = (event: MessageEvent) => {
    const message: ServerMessage = event.data
    switch (message.type) {
      case MESSAGE_NAME.twinngAddMessage: {
        handleAddTemplateMessage(message)
        break
      }
      case MESSAGE_NAME.twinnyOnCompletion: {
        handleCompletionMessage(message)
        break
      }
      case MESSAGE_NAME.twinnyOnLoading: {
        handleLoadingMessage()
        break
      }
      case MESSAGE_NAME.twinnyOnEnd: {
        handleCompletionEnd(message)
        break
      }
      case MESSAGE_NAME.twinnyStopGeneration: {
        setCompletion(null)
        generatingRef.current = false
        chatRef.current?.focus()
        setTimeout(() => {
          stopRef.current = false
        }, 1000)
      }
    }
  }

  const handleStopGeneration = () => {
    stopRef.current = true
    generatingRef.current = false
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyStopGeneration
    } as ClientMessage)
    setCompletion(null)
    setLoading(false)
    generatingRef.current = false
    setTimeout(() => {
      chatRef.current?.focus()
      stopRef.current = false
    }, 200)
  }

  const handleSubmitForm = (input: string) => {
    if (input) {
      setLoading(true)
      setInputText('')
      global.vscode.postMessage({
        type: MESSAGE_NAME.twinnyChatMessage,
        data: [
          ...(messages || []),
          {
            role: USER,
            content: input
          }
        ]
      } as ClientMessage)
      setMessages((prev) => [...(prev || []), { role: USER, content: input }])
      if (isAutoScrolledEnabled) scrollBottom()
    }
  }

  const handleToggleAutoScroll = () => {
    setIsAutoScrolledEnabled((prev) => {
      global.vscode.postMessage({
        type: MESSAGE_NAME.twinnySetWorkspaceContext,
        key: MESSAGE_KEY.autoScroll,
        data: !prev
      } as ClientMessage)

      if (!prev) scrollBottom()

      return !prev
    })
  }

  const handleGetGitChanges = () => {
    global.vscode.postMessage({
      type: MESSAGE_NAME.twinnyGetGitChanges
    } as ClientMessage)
  }

  const handleScrollBottom = () => {
    if (markdownRef.current) {
      markdownRef.current.scrollTop = markdownRef.current.scrollHeight
    }
  }

  const handleChangeChatProvider = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const value = event.target.value
    const provider = providers[value]
    setActiveChatProvider(provider)
  }

  const handleChangeFimProvider = (e: unknown): void => {
    const event = e as React.ChangeEvent<HTMLSelectElement>
    const value = event.target.value
    const provider = providers[value]
    setActiveFimProvider(provider)
  }

  const handleToggleProviderSelection = () => {
    setShowProviders((prev) => {
      global.vscode.postMessage({
        type: MESSAGE_NAME.twinnySetWorkspaceContext,
        key: MESSAGE_KEY.showProviders,
        data: !prev
      } as ClientMessage)
      return !prev
    })
  }

  useEffect(() => {
    window.addEventListener('message', messageEventHandler)
    chatRef.current?.focus()
    scrollBottom()
    return () => {
      window.removeEventListener('message', messageEventHandler)
    }
  }, [isAutoScrolledEnabled])

  useEffect(() => {
    if (autoScrollContext !== undefined)
      setIsAutoScrolledEnabled(autoScrollContext)

    console.log('autoScrollContext', autoScrollContext)

    if (showProvidersContext !== undefined)
      setShowProviders(showProvidersContext)

    if (lastConversation?.length) {
      return setMessages(lastConversation)
    }
    setMessages([])
  }, [lastConversation, autoScrollContext])

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        {showProviders && (
          <>
            <div className={styles.providerSelector}>
              <div>
                <div>Chat</div>
                <VSCodeDropdown
                  value={chatProvider?.id}
                  name='provider'
                  onChange={handleChangeChatProvider}
                >
                  {Object.values(getFimProvidersByType('chat'))
                    .sort((a, b) => a.modelName.localeCompare(b.modelName))
                    .map((provider, index) => (
                      <VSCodeOption key={index} value={provider.id}>
                        {getModelShortName(provider.modelName || '')}
                      </VSCodeOption>
                    ))}
                </VSCodeDropdown>
              </div>
              <div>
                <div>Fill-in-middle</div>
                <VSCodeDropdown
                  value={fimProvider?.id}
                  name='provider'
                  onChange={handleChangeFimProvider}
                >
                  {Object.values(getFimProvidersByType('fim'))
                  .sort((a, b) => a.modelName.localeCompare(b.modelName))
                  .map(
                    (provider, index) => (
                      <VSCodeOption key={index} value={provider.id}>
                        {getModelShortName(provider.modelName || '')}
                      </VSCodeOption>
                    )
                  )}
                </VSCodeDropdown>
              </div>
            </div>
            <VSCodeDivider />
          </>
        )}

        <div className={styles.markdown} ref={markdownRef}>
          {messages?.map((message, index) => (
            <div key={`message-${index}`}>
              <Message message={message} theme={theme} />
            </div>
          ))}
          {loading && (
            <div className={styles.loading}>
              <VSCodeProgressRing aria-label='Loading'></VSCodeProgressRing>
            </div>
          )}
          {!!completion && (
            <>
              <Message
                theme={theme}
                message={{
                  ...completion,
                  role: ASSISTANT
                }}
              />
            </>
          )}
        </div>
        {!!selection.length && (
          <Suggestions isDisabled={!!generatingRef.current} />
        )}
        <div className={styles.chatOptions}>
          <div>
            <VSCodeButton
              onClick={handleToggleAutoScroll}
              title='Toggle auto scroll on/off'
              appearance='icon'
            >
              {isAutoScrolledEnabled ? (
                <EnabledAutoScrollIcon />
              ) : (
                <DisabledAutoScrollIcon />
              )}
            </VSCodeButton>
            <VSCodeButton
              onClick={handleGetGitChanges}
              title='Generate commit message from staged changes'
              appearance='icon'
            >
              <span className='codicon codicon-git-pull-request'></span>
            </VSCodeButton>
            <VSCodeButton
              title='Scroll down to the bottom'
              appearance='icon'
              onClick={handleScrollBottom}
            >
              <span className='codicon codicon-arrow-down'></span>
            </VSCodeButton>
            <VSCodeBadge>{selection?.length}</VSCodeBadge>
          </div>
          <VSCodeButton
            title='Select active models'
            appearance='icon'
            onClick={handleToggleProviderSelection}
          >
            <span className={styles.textIcon}>🤖</span>
          </VSCodeButton>
        </div>
        <form>
          <div className={styles.chatBox}>
            <VSCodeTextArea
              ref={chatRef}
              disabled={generatingRef.current}
              placeholder='Message twinny'
              value={inputText}
              className={styles.chatInput}
              rows={4}
              onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                const target = e.target as HTMLTextAreaElement
                if (e.key === 'Enter' && !e.ctrlKey) {
                  e.preventDefault()

                  handleSubmitForm(target.value)
                } else if (e.ctrlKey && e.key === 'Enter') {
                  setInputText(`${target.value}\n`)
                }
              }}
              onChange={(e) => {
                const event =
                  e as unknown as React.ChangeEvent<HTMLTextAreaElement>
                setInputText(event.target.value)
              }}
            />
          </div>
          <div className={styles.send}>
            {generatingRef.current && (
              <VSCodeButton
                type='button'
                appearance='icon'
                onClick={handleStopGeneration}
                aria-label='Stop generation'
              >
                <span className='codicon codicon-debug-stop'></span>
              </VSCodeButton>
            )}
            <VSCodeButton
              disabled={generatingRef.current}
              onClick={() => handleSubmitForm(inputText)}
              appearance='primary'
            >
              Send message
            </VSCodeButton>
          </div>
        </form>
      </div>
    </VSCodePanelView>
  )
}
