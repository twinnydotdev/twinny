import { ClientRequest, RequestOptions, request } from 'http'
import { request as httpsRequest } from 'https'
import { Uri, commands, window, workspace } from 'vscode'

import path from 'path'
import { StreamBody } from './types'
import { MODEL } from './constants'
import { exec } from 'child_process'

interface StreamResponseOptions {
  body: StreamBody
  options: RequestOptions
  onData: (stringBuffer: string, destroy: () => void) => void
  onEnd?: () => void
  onStart?: (req: ClientRequest) => void
}

export const isLlamaCppStream = (stringBuffer: string) => {
  return stringBuffer.startsWith('data:')
}

export async function streamResponse(opts: StreamResponseOptions) {
  const { body, options, onData, onEnd, onStart } = opts
  const config = workspace.getConfiguration('twinny')
  const useTls = config.get('useTls')

  const _request = useTls ? httpsRequest : request

  let stringBuffer = ''

  const req = _request(options, (res) => {
    res.on('data', (chunk: string) => {
      stringBuffer += chunk
      if (/\n$/.exec(chunk)) {
        onData(stringBuffer, () => {
          res.destroy()
        })
        stringBuffer = ''
      }
    })
    res.once('end', () => {
      onEnd?.()
    })
  })

  req.on('error', (error) => {
    console.error(`Request error: ${error.message}`)
  })

  try {
    req.write(JSON.stringify(body))
    onStart?.(req)
    req.end()
  } catch (e) {
    req.destroy()
  }
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

export const getPromptModel = (model: string) => {
  return model.includes(MODEL.llama) ? MODEL.llama : MODEL.deepseek
}

export const getIsModelAvailable = (model: string) => {
  return new Promise<boolean>((resolve, reject) => {
    exec('ollama list', (error, stdout) => {
      if (error) {
        console.log(`exec error: ${error.message}`)
        reject()
      }

      if (stdout.match(model)) {
        resolve(true)
      }

      resolve(false)
    })
  })
}

export const noop = () => undefined
