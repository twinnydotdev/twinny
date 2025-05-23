/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert"
import * as vscode from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  INFERENCE_PROVIDERS_STORAGE_KEY
} from "../../common/constants"
import {
  ProviderManager,
  TwinnyProvider
} from "../../extension/provider-manager"

suite("ProviderManager Test Suite", () => {
  let context: vscode.ExtensionContext
  let webview: vscode.Webview
  let providerManager: ProviderManager

  setup(() => {
    // Mock extension context
    context = {
      globalState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => []
      }
    } as any

    // Mock webview
    webview = {
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: () => ({ dispose: () => {} })
    } as any

    providerManager = new ProviderManager(context, webview)
  })

  test("addProvider should set FIM provider as active when none exists", () => {
    const mockProvider: TwinnyProvider = {
      id: "test-fim-provider",
      label: "Test FIM Provider",
      type: "fim",
      provider: "litellm",
      modelName: "gemini-2.0-flash-lite-preview-02-05",
      apiHostname: "localhost",
      apiPort: 4000,
      apiPath: "/chat/completions",
      apiProtocol: "http"
    }

    let activeFimProvider: TwinnyProvider | undefined
    let providers: Record<string, TwinnyProvider> = {}

    // Mock globalState to track updates
    context.globalState.get = (key: string) => {
      if (key === ACTIVE_FIM_PROVIDER_STORAGE_KEY) return activeFimProvider
      if (key === INFERENCE_PROVIDERS_STORAGE_KEY) return providers
      return undefined
    }

    context.globalState.update = (key: string, value: any) => {
      if (key === ACTIVE_FIM_PROVIDER_STORAGE_KEY) {
        activeFimProvider = value
      } else if (key === INFERENCE_PROVIDERS_STORAGE_KEY) {
        providers = value
      }
      return Promise.resolve()
    }

    // Add the provider
    const result = providerManager.addProvider(mockProvider)

    // Verify the provider was added and set as active
    assert.strictEqual(result?.type, "fim")
    assert.strictEqual(activeFimProvider?.type, "fim")
    assert.strictEqual(activeFimProvider?.provider, "litellm")
    assert.strictEqual(
      activeFimProvider?.modelName,
      "gemini-2.0-flash-lite-preview-02-05"
    )
  })

  test("addProvider should not override existing active FIM provider", () => {
    const existingProvider: TwinnyProvider = {
      id: "existing-fim-provider",
      label: "Existing FIM Provider",
      type: "fim",
      provider: "ollama",
      modelName: "codellama:7b-code",
      apiHostname: "0.0.0.0",
      apiPort: 11434,
      apiPath: "/api/generate",
      apiProtocol: "http"
    }

    const newProvider: TwinnyProvider = {
      id: "new-fim-provider",
      label: "New FIM Provider",
      type: "fim",
      provider: "litellm",
      modelName: "gemini-2.0-flash-lite-preview-02-05",
      apiHostname: "localhost",
      apiPort: 4000,
      apiPath: "/chat/completions",
      apiProtocol: "http"
    }

    let activeFimProvider: TwinnyProvider | undefined = existingProvider
    let providers: Record<string, TwinnyProvider> = {
      [existingProvider.id]: existingProvider
    }

    // Mock globalState
    context.globalState.get = (key: string) => {
      if (key === ACTIVE_FIM_PROVIDER_STORAGE_KEY) return activeFimProvider
      if (key === INFERENCE_PROVIDERS_STORAGE_KEY) return providers
      return undefined
    }

    context.globalState.update = (key: string, value: any) => {
      if (key === ACTIVE_FIM_PROVIDER_STORAGE_KEY) {
        activeFimProvider = value
      } else if (key === INFERENCE_PROVIDERS_STORAGE_KEY) {
        providers = value
      }
      return Promise.resolve()
    }

    // Add the new provider
    providerManager.addProvider(newProvider)

    // Verify the existing active provider wasn't changed
    assert.strictEqual(activeFimProvider?.id, existingProvider.id)
    assert.strictEqual(activeFimProvider?.provider, "ollama")
  })

  test("removeProvider should clear active provider when removing active FIM provider", () => {
    const fimProvider: TwinnyProvider = {
      id: "fim-provider-to-remove",
      label: "FIM Provider to Remove",
      type: "fim",
      provider: "litellm",
      modelName: "gemini-2.0-flash-lite-preview-02-05",
      apiHostname: "localhost",
      apiPort: 4000,
      apiPath: "/chat/completions",
      apiProtocol: "http"
    }

    let activeFimProvider: TwinnyProvider | undefined = fimProvider
    let providers: Record<string, TwinnyProvider> = {
      [fimProvider.id]: fimProvider
    }

    // Mock globalState
    context.globalState.get = (key: string) => {
      if (key === ACTIVE_FIM_PROVIDER_STORAGE_KEY) return activeFimProvider
      if (key === ACTIVE_CHAT_PROVIDER_STORAGE_KEY) return undefined
      if (key === ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY) return undefined
      if (key === INFERENCE_PROVIDERS_STORAGE_KEY) return providers
      return undefined
    }

    context.globalState.update = (key: string, value: any) => {
      if (key === ACTIVE_FIM_PROVIDER_STORAGE_KEY) {
        activeFimProvider = value
      } else if (key === INFERENCE_PROVIDERS_STORAGE_KEY) {
        providers = value
      }
      return Promise.resolve()
    }

    // Remove the provider
    providerManager.removeProvider(fimProvider)

    // Verify the active provider was cleared
    assert.strictEqual(activeFimProvider, undefined)
    assert.strictEqual(providers[fimProvider.id], undefined)
  })

  test("Bug reproduction: Delete all providers, add new FIM provider should work", () => {
    // Simulate the bug scenario
    let activeFimProvider: TwinnyProvider | undefined
    let providers: Record<string, TwinnyProvider> = {}

    // Mock globalState
    context.globalState.get = (key: string) => {
      if (key === ACTIVE_FIM_PROVIDER_STORAGE_KEY) return activeFimProvider
      if (key === ACTIVE_CHAT_PROVIDER_STORAGE_KEY) return undefined
      if (key === ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY) return undefined
      if (key === INFERENCE_PROVIDERS_STORAGE_KEY) return providers
      return undefined
    }

    context.globalState.update = (key: string, value: any) => {
      if (key === ACTIVE_FIM_PROVIDER_STORAGE_KEY) {
        activeFimProvider = value
      } else if (key === INFERENCE_PROVIDERS_STORAGE_KEY) {
        providers = value
      }
      return Promise.resolve()
    }

    // Step 1: Add a new FIM provider (simulating user adding after deleting all)
    const newFimProvider: TwinnyProvider = {
      id: "new-litellm-fim",
      label: "Ollama FIM",
      type: "fim",
      provider: "litellm",
      modelName: "gemini-2.0-flash-lite-preview-02-05",
      apiHostname: "localhost",
      apiPort: 4000,
      apiPath: "/chat/completions",
      apiProtocol: "http"
    }

    const result = providerManager.addProvider(newFimProvider)

    // Step 2: Verify the new provider is set as active (this should work with the fix)
    assert.strictEqual(result?.type, "fim")
    assert.strictEqual(activeFimProvider?.provider, "litellm")
    assert.strictEqual(
      activeFimProvider?.modelName,
      "gemini-2.0-flash-lite-preview-02-05"
    )
    assert.strictEqual(activeFimProvider?.apiHostname, "localhost")
    assert.strictEqual(activeFimProvider?.apiPort, 4000)

    // Step 3: Verify that FIM completion would use the correct provider
    const retrievedProvider = providerManager.getActiveFimProvider()
    assert.strictEqual(retrievedProvider?.provider, "litellm")
    assert.strictEqual(
      retrievedProvider?.modelName,
      "gemini-2.0-flash-lite-preview-02-05"
    )
  })
})
