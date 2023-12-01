/* eslint-disable @typescript-eslint/no-explicit-any */
import { request } from 'http'
import { RequestOptions } from 'https'
export async function streamResponse(
  options: RequestOptions,
  body: any,
  cb: (chunk: string, resolve: () => void) => void
) {
  const req = request(options, (res) => {
    res.on('data', (chunk: string) => {
      cb(chunk.toString(), () => {
        res.destroy()
      })
    })
  })

  req.on('error', (error) => {
    console.error(`Request error: ${error.message}`)
  })

  req.write(JSON.stringify(body))
  req.end()
}
