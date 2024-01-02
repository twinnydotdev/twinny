import { request } from 'http'
import { RequestOptions } from 'https'
import { Uri, WebviewView, commands, window, workspace } from 'vscode'

interface StreamBody {
  model: string
  prompt: string
}

export async function streamResponse(
  options: RequestOptions,
  body: StreamBody,
  onData: (chunk: string, resolve: () => void) => void,
  onEnd?: () => void
) {
  const req = request(options, (res) => {
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
  req.end()
}

export function chatCompletion(
  getPrompt: (code: string) => string,
  view?: WebviewView
) {
  view?.webview.postMessage({
    type: 'onLoading'
  })

  const editor = window.activeTextEditor
  const config = workspace.getConfiguration('twinny')
  const chatModel = config.get('chatModelName') as string
  const hostname = config.get('ollamaBaseUrl') as string
  const port = config.get('ollamaApiPort') as number
  const selection = editor?.selection
  const text = editor?.document.getText(selection)
  const prompt = getPrompt(text || '')

  let completion = ''

  streamResponse(
    {
      hostname,
      port,
      method: 'POST',
      path: '/api/generate'
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
          type: 'onCompletion',
          value: completion.trimStart()
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
        type: 'onEnd',
        value: completion
      })
    }
  )
}

export function openDiffView(original: string, proposed: string) {
  const uri1 = Uri.file('./tmp/original.txt')
  const uri2 = Uri.file('./tmp/proposed.txt')

  workspace.fs.writeFile(uri1, Buffer.from(original, 'utf8'))
  workspace.fs.writeFile(uri2, Buffer.from(proposed, 'utf8'))

  commands.executeCommand('vscode.diff', uri1, uri2)
}
