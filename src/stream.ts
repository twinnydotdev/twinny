import { IncomingMessage, request } from 'http'
import { request as httpsRequest } from 'https'
import { workspace } from 'vscode'
import { StreamResponse, StreamResponseOptions } from './types'
import { LINE_BREAK_REGEX } from './constants'
import { Logger } from './logger'

const logger = new Logger()

const logStreamOptions = (opts: StreamResponseOptions) => {
  logger.log(
    `
***Twinny Stream Debug***\n\
Streaming response from ${opts.options.hostname}:${opts.options.port}.\n\
Request body:\n${JSON.stringify(opts.body, null, 2)}\n\n
Request options:\n${JSON.stringify(opts.options, null, 2)}\n\n
    `
  )
}

export async function streamResponse(opts: StreamResponseOptions) {
  const { body, options, onData, onEnd, onError, onStart } = opts
  const config = workspace.getConfiguration('twinny')
  const useTls = config.get('useTls')
  const timeoutDuration = 20000
  const _request = useTls ? httpsRequest : request
  let stringBuffer = ''
  logStreamOptions(opts)

  const req = _request(options, (res: IncomingMessage) => {
    const statusCode = res.statusCode

    if (typeof statusCode !== 'number') {
      onError?.(new Error('Response statusCode is undefined'))
      return
    }

    if (statusCode < 200 || statusCode >= 300) {
      logger.log(`Response status code ${statusCode}\n`)
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
        logger.log('Error parsing response\n')
        onError?.(e instanceof Error ? e : new Error('Error processing data'))
        res.destroy()
      }
    })

    res.once('end', () => {
      logger.log('Stream ended')
      onEnd?.(() => res.destroy())
    })
  })

  req.on('error', (error: Error) => {
    logger.log(`Error in stream request ${error.message}\n`)
    onError?.(error)
  })

  req.setTimeout(timeoutDuration, () => {
    logger.log('Stream request timed out')
    req.destroy()
    onError?.(new Error('Request timed out'))
  })

  try {
    logger.log('Stream started')
    if (body) req.write(JSON.stringify(body))
    onStart?.(req)
    req.end()
  } catch (e) {
    logger.log('Error sending request\n')
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
