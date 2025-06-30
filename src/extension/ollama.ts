import { workspace } from "vscode"

export class OllamaService {
  private _config = workspace.getConfiguration("twinny")
  private _baseUrl: string

  constructor() {
    const protocol = (this._config.get("ollamaUseTls") as boolean)
      ? "https"
      : "http"
    const hostname = this._config.get("ollamaHostname") as string
    const port = this._config.get("ollamaApiPort") as string
    this._baseUrl = `${protocol}://${hostname}:${port}`
  }

  public fetchModels = async (resource = "/api/tags") => {
    try {
      const response = await fetch(`${this._baseUrl}${resource}`)
      const { models } = await response.json()
      return Array.isArray(models) ? [...new Set(models)] : []
    } catch {
      return []
    }
  }

  public testConnection = async () => {
    try {
      const response = await fetch(`${this._baseUrl}/api/tags`) // Using /api/tags as a simple test endpoint
      if (response.ok) {
        return { success: true }
      } else {
        return { success: false, error: `Server responded with status: ${response.status}` }
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
