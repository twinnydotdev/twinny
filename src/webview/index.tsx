import { createRoot } from "react-dom/client"

import { Main } from "./main"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).vscode = window.acquireVsCodeApi()

const container = document.querySelector("#root")
const panelContainer = document.querySelector("#root-panel")

if (container) {
  const root = createRoot(container)
  root.render(<Main />)
}

if (panelContainer) {
  const root = createRoot(panelContainer)
  root.render(<Main fullScreen />)
}
