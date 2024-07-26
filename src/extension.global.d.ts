declare module '@lancedb/vectordb-linux-x64-gnu'
declare module 'hyperswarm'
declare module 'b4a'

declare module 'hypercore-crypto' {
  const hyperCoreCrypto: {
    keyPair: () => { publicKey: Buffer; secretKey: Buffer }
    discoveryKey: (publicKey: Buffer) => Buffer
    randomBytes: (n?: number) => Buffer
    verify: (challenge: Buffer, signature: Buffer, publicKey: Buffer) => boolean
  }

  export = hyperCoreCrypto
}
