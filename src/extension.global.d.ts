declare module "hyperswarm"
declare module "b4a"
declare module "@tiptap/extension-placeholder"

declare module "hypercore-crypto" {
  const hyperCoreCrypto: {
    keyPair: () => { publicKey: Buffer; secretKey: Buffer }
    discoveryKey: (publicKey: Buffer) => Buffer
    randomBytes: (n?: number) => Buffer
    verify: (challenge: Buffer, signature: Buffer, publicKey: Buffer) => boolean
  }

  export default hyperCoreCrypto
}

declare module "*.css"

declare module "*.css" {
  const content: Record<string, string>
  export default content
}

declare module "*.svg" {
  const content: string
  export default content
}


interface Window {
  acquireVsCodeApi: <T = unknown>() => {
    getState: () => T
    setState: (data: T) => void
    postMessage: (msg: unknown) => void
  }
}
