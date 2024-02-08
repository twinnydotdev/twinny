import { IncomingMessage, request } from 'http'
import { request as httpsRequest } from 'https'
import { workspace } from 'vscode'
import { StreamResponse, StreamResponseOptions } from './types'
import { LINE_BREAK_REGEX } from './constants'

export async function streamResponse(opts: StreamResponseOptions) {
  const { body, options, onData, onEnd, onError, onStart } = opts
  const config = workspace.getConfiguration('twinny')
  const useTls = config.get('useTls')
  const timeoutDuration = 20000
  const _request = useTls ? httpsRequest : request
  let stringBuffer = ''

  const req = _request(options, (res: IncomingMessage) => {
    const statusCode = res.statusCode

    if (typeof statusCode !== 'number') {
      onError?.(new Error('Response statusCode is undefined'))
      return
    }

    if (statusCode < 200 || statusCode >= 300) {
      onError?.(new Error(`Server responded with status code: ${statusCode}`))
      res.destroy()
      return
    }

    res.on('data', (chunk: string) => {
      stringBuffer += chunk.toString()
      try {
        if (LINE_BREAK_REGEX.exec(stringBuffer)) {
          const jsonResponse = safeParseJsonResponse(stringBuffer)
          onData(jsonResponse, () => res.destroy())
          stringBuffer = ''
        }
      } catch (e) {
        onError?.(e instanceof Error ? e : new Error('Error processing data'))
        res.destroy()
      }
    })

    res.once('end', () => {
      onEnd?.(() => res.destroy())
    })
  })

  req.on('error', (error: Error) => {
    onError?.(error)
  })

  req.setTimeout(timeoutDuration, () => {
    req.destroy()
    onError?.(new Error('Request timed out'))
  })

  try {
    if (body) {
      req.write(JSON.stringify(body))
    }
    onStart?.(req)
    req.end()
  } catch (e) {
    onError?.(e instanceof Error ? e : new Error('Error sending request'))
    req.destroy()
  }
}

function isStreamWithDataPrefix(stringBuffer: string) {
  return stringBuffer.startsWith('data:')
}

function safeParseJsonResponse(
  stringBuffer: string
): StreamResponse | undefined {
  try {
    if (isStreamWithDataPrefix(stringBuffer)) {
      return JSON.parse(stringBuffer.split('data:')[1])
    }
    return JSON.parse(stringBuffer)
  } catch (e) {
    return undefined
  }
}
