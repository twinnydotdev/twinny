import { createRoot } from 'react-dom/client'

import Sidebar from './chat'

import './index.css'

const container = document.querySelector('#root')

if (container) {
  const root = createRoot(container)
  root.render(<Sidebar />)
}
