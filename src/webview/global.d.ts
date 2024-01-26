/* eslint-disable @typescript-eslint/no-explicit-any */
declare module '*.css'

declare module '*.css' {
  const content: Record<string, string>
  export default content
}

interface Window {
  acquireVsCodeApi: <T = unknown>() => {
    getState: () => T
    setState: (data: T) => void
    postMessage: (msg: unknown) => void
  }
}
