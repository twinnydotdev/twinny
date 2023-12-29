import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  VSCodeButton,
  VSCodeTextArea,
  VSCodePanelView
} from '@vscode/webview-ui-toolkit/react'

interface PostMessage {
  type: string
  value: string
}

const ChatInterface = () => {
  const [inputText, setInputText] = useState('')
  const [text, setText] = useState('')
  const [completion, setCompletion] = useState('')

  const handleSendMessage = () => {
    if (inputText.trim()) {
      setInputText('')
    }
  }

  useEffect(() => {
    window.addEventListener('message', (event) => {
      const message: PostMessage = event.data
      switch (message.type) {
        case 'onSelectedText': {
          setCompletion(message.value)
          break
        }
      }
    })
  }, [])

  return (
    <VSCodePanelView>
      <Markdown remarkPlugins={[remarkGfm]}>{completion}</Markdown>
      <VSCodeTextArea value={text} />
      <VSCodeButton appearance="primary" onClick={handleSendMessage}>
        Send
      </VSCodeButton>
    </VSCodePanelView>
  )
}

export default ChatInterface
