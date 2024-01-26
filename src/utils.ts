import { ClientRequest, RequestOptions, request } from 'http'
import { request as httpsRequest } from 'https'
import { ColorThemeKind, Uri, commands, window, workspace } from 'vscode'

import path from 'path'
import { StreamOptions, StreamResponse, Theme } from './types'
import { languages } from './languages'

interface StreamResponseOptions {
  body: StreamOptions
  options: RequestOptions
  onData: (
    streamResponse: StreamResponse | undefined,
    destroy: () => void
  ) => void
  onEnd?: () => void
  onStart?: (req: ClientRequest) => void
}

export const isLlamaCppStream = (stringBuffer: string) => {
  return stringBuffer.startsWith('data:')
}

const safeParseJson = (stringBuffer: string): StreamResponse | undefined => {
  try {
    if (isLlamaCppStream(stringBuffer)) {
      return JSON.parse(stringBuffer.split('data:')[1])
    }
    return JSON.parse(stringBuffer)
  } catch (e) {
    return undefined
  }
}

export async function streamResponse(opts: StreamResponseOptions) {
  const { body, options, onData, onEnd, onStart } = opts
  const config = workspace.getConfiguration('twinny')
  const useTls = config.get('useTls')

  const _request = useTls ? httpsRequest : request

  let stringBuffer = ''

  const req = _request(options, (res) => {
    res.on('data', (chunk: string) => {
      stringBuffer += chunk.toString()
      try {
        if (/\n$/.exec(stringBuffer)) {
          const streamResponse = safeParseJson(stringBuffer)
          onData(streamResponse, () => res.destroy())
          stringBuffer = ''
        }
      } catch (e) {
        return
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

export const getLanguage = () => {
  const editor = window.activeTextEditor
  const languageId = editor?.document.languageId
  const language = languages[languageId as keyof typeof languages]
  return {
    language,
    languageId
  }
}

export const getTheme = () => {
  const currentTheme = window.activeColorTheme
  if (currentTheme.kind === ColorThemeKind.Light) {
    return Theme.Light
  } else if (currentTheme.kind === ColorThemeKind.Dark) {
    return Theme.Dark
  } else {
    return Theme.Contrast
  }
}

export const noop = () => undefined
