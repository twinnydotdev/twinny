import { createRoot } from 'react-dom/client'

import { Chat } from './chat'

const container = document.querySelector('#root')

if (container) {
  const root = createRoot(container)
  root.render(<Chat />)
}
