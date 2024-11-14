import { ErrorType,logConsoleError,StreamRequest } from "../common/types"

import { logStreamOptions, safeParseJsonResponse } from "./utils"

import * as vscode from 'vscode';

export async function streamResponse(request: StreamRequest) {
  logStreamOptions(request)
  const { body, options, onData, onEnd, onError, onStart } = request
  const controller = new AbortController()
  const { signal } = controller

  const timeOut = setTimeout(() => {
    controller.abort()
    onError?.(new Error("Request timed out"))
    logConsoleError(ErrorType.Timeout, 'Failed to establish connection', new Error("Request timed out"));
  }, 25000)

  try {
    const url = `${options.protocol}://${options.hostname}${options.port ? `:${options.port}` : ""}${options.path}`
    const fetchOptions = {
      method: options.method,
      headers: options.headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    }

    const response = await fetch(url, fetchOptions)
    clearTimeout(timeOut)

    if (!response.ok) {
      throw new Error(`Server responded with status code: ${response.status}`)
    }

    if (!response.body) {
      throw new Error("Failed to get a ReadableStream from the response")
    }

    let buffer = ""

    onStart?.(controller)

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream({
          start() {
            buffer = ""
          },
          transform(chunk) {
            buffer += chunk
            let position
            while ((position = buffer.indexOf("\n")) !== -1) {
              const line = buffer.substring(0, position)
              buffer = buffer.substring(position + 1)
              try {
                const json = safeParseJsonResponse(line)
                if (json) onData(json)
              } catch (e) {
                onError?.(new Error("Error parsing JSON data from event"))
              }
            }
          },
          flush() {
            if (buffer) {
              try {
                const json = safeParseJsonResponse(buffer)
                onData(json)
              } catch (e) {
                onError?.(new Error("Error parsing JSON data from event"))
              }
            }
          },
        })
      )
      .getReader()

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal.aborted) break
      const { done } = await reader.read()
      if (done) break
    }

    controller.abort()
    onEnd?.()
    reader.releaseLock()
  } catch (error: unknown) {
    clearTimeout(timeOut)
    controller.abort()
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        onEnd?.()
      } else {
        logConsoleError(ErrorType.Fetch_Error, 'Fetch error', error);
        onError?.(error)
        fitchErrorDetection(error)
      }
    }
  }
}

export async function fetchEmbedding(request: StreamRequest) {
  const { body, options, onData } = request
  const controller = new AbortController()


  try {
    const url = `${options.protocol}://${options.hostname}${options.port ? `:${options.port}` : ""}${options.path}`
    const fetchOptions = {
      method: options.method,
      headers: options.headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      throw new Error(`Server responded with status code: ${response.status}`)
    }

    if (!response.body) {
      throw new Error("Failed to get a ReadableStream from the response")
    }

    const data = await response.json()

    onData(data)

  } catch (error: unknown) {
    if (error instanceof Error) {
      logConsoleError(ErrorType.Fetch_Error, 'Fetch error', error);
      fitchErrorDetection(error)
    }
  }
}

//Define an array containing all the error messages that need to be detected when fetch error occurred
const knownErrorMessages = [
  "First parameter has member 'readable' that is not a ReadableStream.", //This error occurs When plugins such as Fitten Code are enabled
  "The 'transform.readable' property must be an instance of ReadableStream. Received an instance of h" //When you try to enable the Node.js compatibility mode Compat to solve the problem, this error may pop up
];

function fitchErrorDetection(error: Error) {
  //Using array matching error
  if (knownErrorMessages.some(msg => error.message.includes(msg))) {
    vscode.window.showInformationMessage(
      "Besides Twinny, there may be other AI extensions being enabled (such as Fitten Code) that are affecting the behavior of the fetch API or ReadableStream used in the Twinny plugin. We recommend that you disable that AI plugin for the smooth use of Twinny",
      "View extensions",
      "Restart Vscode (after disabling related extensions)"
    ).then((selected) => {
      if (selected === "View extensions") {
        vscode.commands.executeCommand('workbench.view.extensions');
      } else if (selected === "Restart Vscode (after disabling related extensions)") {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  }
}