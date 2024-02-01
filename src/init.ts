import { exec } from 'child_process'
import {
  Uri,
  window,
  env,
  ProgressLocation,
  workspace,
  CancellationToken,
  commands,
  ConfigurationTarget
} from 'vscode'

import { OLLAMA_DOWNLOAD_URL } from './constants'

const config = workspace.getConfiguration('twinny')

export async function init() {
  const fimModel = config.get('fimModelName') as string
  const chatModel = config.get('chatModelName') as string
  const apiUrl = config.get('apiUrl') as string
  const disableServerChecks = config.get('disableServerChecks') as boolean

  if (apiUrl !== 'localhost' || disableServerChecks) {
    return
  }

  const isInstalled = await getIsInstalled()

  if (!isInstalled) {
    await window.showInformationMessage(
      'Ollama installation required by twinny',
      'Install Ollama'
    )

    env.openExternal(Uri.parse(OLLAMA_DOWNLOAD_URL))
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
        exec('ollama list', async (error) => {
          console.log(
            'Running \'ollama list\' to check if ollama server is running.'
          )

          if (error) {
            // Ollama is installed but the service is stopped.
            window.showInformationMessage(
              'Something went wrong when trying to contact the Ollama server...'
            )
            return resolve(false)
          }

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
                  config
                    .update(
                      'disableServerChecks',
                      true,
                      ConfigurationTarget.Global
                    )
                    .then(() => {
                      if (workspace.workspaceFolders) {
                        config.update(
                          'disableServerChecks',
                          true,
                          ConfigurationTarget.Workspace
                        )
                      }
                      setTimeout(() => {
                        commands.executeCommand('workbench.action.reloadWindow')
                      }, 500)
                    })

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
              window.showInformationMessage(
                'Something went wrong or model download cancelled.'
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
