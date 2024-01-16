import { ClientRequest, RequestOptions, request } from 'http'
import { request as httpsRequest } from 'https'
import { Uri, WebviewView, commands, window, workspace } from 'vscode'

import { prompts } from './prompts'
import path from 'path'
import { MESSAGE_NAME, MODEL } from './constants'

interface StreamBody {
  model: string
  prompt: string
}

export async function streamResponse(
  options: RequestOptions,
  body: StreamBody,
  onData: (chunk: string, resolve: () => void) => void,
  onEnd?: () => void,
  cb?: (req: ClientRequest) => void,
  useTls = false
) {
  const _request = useTls ? httpsRequest : request

  const req = _request(options, (res) => {
    res.on('data', (chunk: string) => {
      onData(chunk.toString(), () => {
        res.destroy()
      })
    })

    res.once('end', () => {
      onEnd?.()
    })
  })

  req.on('error', (error) => {
    console.error(`Request error: ${error.message}`)
  })

  req.write(JSON.stringify(body))
  cb?.(req)
  req.end()
}

export function chatCompletion(
  type: string,
  view?: WebviewView,
  getPrompt?: (code: string) => string
) {
  view?.webview.postMessage({
    type: MESSAGE_NAME.twinnyOnLoading
  })

  const editor = window.activeTextEditor
  const config = workspace.getConfiguration('twinny')
  const chatModel = config.get('chatModelName') as string
  const hostname = config.get('ollamaBaseUrl') as string
  const port = config.get('ollamaApiPort') as number
  const useTls = config.get('ollamaUseTls') as boolean
  const bearerToken = config.get('ollamaApiBearerToken') as string
  const selection = editor?.selection
  const modelType = chatModel.includes(MODEL.llama)
    ? MODEL.llama
    : MODEL.deepseek
  const text = editor?.document.getText(selection) || ''
  const template = prompts[type] ? prompts[type](text, modelType) : ''
  const prompt: string = template ? template : getPrompt?.(text) || ''

  let completion = ''
  const headers: Record<string, string> = {};

  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  streamResponse(
    {
      hostname,
      port,
      method: 'POST',
      path: '/api/generate',
      headers,
    },
    {
      model: chatModel,
      prompt
    },
    (chunk, onComplete) => {
      try {
        const json = JSON.parse(chunk)
        completion = completion + json.response

        view?.webview.postMessage({
          type: MESSAGE_NAME.twinnyOnCompletion,
          value: {
            type,
            completion: completion.trimStart()
          }
        })
        if (json.response.match('<EOT>')) {
          onComplete()
        }
      } catch (error) {
        console.error('Error parsing JSON:', error)
        return
      }
    },
    () => {
      view?.webview.postMessage({
        type: MESSAGE_NAME.twinnyOnEnd,
        value: {
          type,
          completion: completion.trimStart()
        }
      })
    },
    (req: ClientRequest) => {
      view?.webview.onDidReceiveMessage((data: { type: string }) => {
        if (data.type === MESSAGE_NAME.twinnyStopGeneration) {
          req.destroy()
        }
      })
    },
    useTls
  )
}

const tmpDir = path.join(__dirname, './tmp')

export function openDiffView(original: string, proposed: string) {
  const uri1 = Uri.file(`${tmpDir}/twinny-original.txt`)
  const uri2 = Uri.file(`${tmpDir}/twinny-proposed.txt`)

  workspace.fs.writeFile(uri1, Buffer.from(original, 'utf8'))
  workspace.fs.writeFile(uri2, Buffer.from(proposed, 'utf8'))

  commands.executeCommand('vscode.diff', uri1, uri2)
}

export async function deleteTempFiles() {
  const dir = Uri.file(tmpDir)

  try {
    const files = await workspace.fs.readDirectory(dir)

    for (const [file] of files) {
      const fileUri = Uri.file(path.join(dir.path, file))
      await workspace.fs.delete(fileUri)
    }
  } catch (err) {
    return
  }
}

export const delayExecution = <T extends () => void>(
  fn: T,
  delay = 200
): NodeJS.Timeout => {
  return setTimeout(() => {
    fn()
  }, delay)
}

export const getTextSelection = () => {
  const editor = window.activeTextEditor
  const selection = editor?.selection
  const text = editor?.document.getText(selection)
  return text || ''
}

export const noop = () => undefined
