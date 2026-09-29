import { createRoot } from "react-dom/client"

import { Main } from "./main"

import "./styles/theme.css"

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
