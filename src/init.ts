import { exec } from 'child_process'
import {
  Uri,
  window,
  env,
  ProgressLocation,
  workspace,
  CancellationToken,
  commands
} from 'vscode'
import { getContext } from './context'
import { MESSAGE_KEY, MESSAGE_NAME } from './constants'

const OLLAMA_URL = 'https://ollama.ai/download'

export async function init() {
  const config = workspace.getConfiguration('twinny')
  const fimModel = config.get('fimModelName') as string
  const chatModel = config.get('chatModelName') as string
  const ollamaBaseUrl = config.get('ollamaBaseUrl') as string
  const context = getContext()

  if (ollamaBaseUrl !== 'localhost') {
    // Running twinny with external Ollama server.
    return
  }

  const isInstalled = await getIsInstalled()

  if (!isInstalled) {
    await window.showInformationMessage(
      'Ollama installation required by twinny',
      'Install Ollama'
    )

    env.openExternal(Uri.parse(OLLAMA_URL))
  }

  const settingsKey = `${MESSAGE_NAME.twinnyGlobalContext}-${MESSAGE_KEY.downloadCancelled}`

  const isDownloadCancelled = context?.globalState.get(settingsKey)

  if (isDownloadCancelled) {
    await startServer()
    return
  }

  await checkModel(fimModel)

  await checkModel(chatModel)

  await startServer()
}

function getIsInstalled() {
  return new Promise((resolve) => {
    exec('ollama --version', (error) => {
      if (error) {
        console.log('Ollama is not installed.')
        resolve(false)
      } else {
        exec('ollama list', async () => {
          console.log(
            'Running \'ollama list\' to check if ollama server is running.'
          )
          resolve(true)
        })
      }
    })
  })
}

async function startServer() {
  exec('ollama serve')
  return new Promise((resolve) => setTimeout(() => resolve(true), 1000))
}

async function checkModel(model: string) {
  const context = getContext()
  return new Promise((resolve) => {
    exec('ollama list', (error, stdout) => {
      if (error) throw error

      if (!stdout.match(model)) {
        window
          .withProgress(
            {
              location: ProgressLocation.Notification,
              title: 'twinny downloading',
              cancellable: true
            },
            async (progress, token: CancellationToken) => {
              return new Promise((resolve, reject) => {
                const childProcess = exec(`ollama pull ${model}`)

                childProcess.stdout?.addListener('data', (data) => {
                  console.log(`stdout: ${data}`)
                })

                childProcess.stderr?.addListener('data', (chunk) => {
                  const regex = /(\d+)%/gim
                  const match = chunk.match(regex)

                  if (match) {
                    const percent = match[0].replace('%', '')

                    progress.report({
                      message: `${model} ${parseInt(percent)}%`
                    })
                  }
                })

                childProcess.on('close', (code) => {
                  if (code !== 0) {
                    reject(
                      new Error(`ollama pull process exited with code ${code}`)
                    )
                  } else {
                    resolve('')
                  }
                })

                token.onCancellationRequested(() => {
                  commands.executeCommand('workbench.action.reloadWindow');

                  context?.globalState.update(
                    `${MESSAGE_NAME.twinnyGlobalContext}-${MESSAGE_KEY.downloadCancelled}`,
                    true
                  )
                  reject()
                })
              })
            }
          )
          .then(
            () => {
              window.showInformationMessage(
                'Ollama has been installed. Please reload window to enable twinny.'
              )
              resolve(true)
            },
            () => {
              window.showErrorMessage(
                `Something went wrong when trying to download the model ${model}.`
              )
              resolve(false)
            }
          )
      } else {
        resolve(true)
      }
    })
  })
}
