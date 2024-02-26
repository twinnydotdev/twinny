import { StreamRequest } from '../common/types'
import { logStreamOptions, safeParseJsonResponse } from './utils'
import { COMPLETION_TIMEOUT } from '../common/constants'

export async function streamResponse(request: StreamRequest) {
  logStreamOptions(request)
  const { body, options, onData, onEnd, onError, onStart } = request
  const controller = new AbortController()

  const { signal } = controller

  const timeoutId = setTimeout(() => {
    controller.abort()
  }, COMPLETION_TIMEOUT)

  const cleanup = () => {
    clearTimeout(timeoutId)
    controller.abort()
  }

  try {
    const url = `${options.protocol}://${options.hostname}:${options.port}${options.path}`
    const fetchOptions = {
      method: options.method,
      headers: options.headers,
      body: JSON.stringify(body),
      signal: controller.signal
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      throw new Error(`Server responded with status code: ${response.status}`)
    }

    if (!response.body) {
      throw new Error('Failed to get a ReadableStream from the response')
    }

    let buffer = ''

    onStart?.(controller)

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream({
          start() {
            buffer = ''
          },
          transform(chunk) {
            buffer += chunk
            let position
            while ((position = buffer.indexOf('\n')) !== -1) {
              const line = buffer.substring(0, position)
              buffer = buffer.substring(position + 1)
              try {
                const json = safeParseJsonResponse(line)
                if (json) {
                  onData(json)
                }
              } catch (e) {
                onError?.(new Error('Error parsing JSON data from event'))
              }
            }
          },
          flush() {
            if (buffer) {
              try {
                const json = safeParseJsonResponse(buffer)
                onData(json)
              } catch (e) {
                onError?.(new Error('Error parsing JSON data from event'))
              }
            }
          }
        })
      )
      .getReader()

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal.aborted) break
      const { done } = await reader.read()
      if (done) break
    }

    cleanup()
    onEnd?.()
    reader.releaseLock()
  } catch (error: unknown) {
    cleanup()
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        onEnd?.()
      } else {
        console.error('Fetch error:', error)
      }
    }
  }
}
