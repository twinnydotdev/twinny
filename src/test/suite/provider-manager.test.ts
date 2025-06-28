/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert"
import * as sinon from "sinon"
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
  let getConfigurationStub: sinon.SinonStub
  let globalStateGetStub: sinon.SinonStub
  let globalStateUpdateStub: sinon.SinonStub
  let postMessageSpy: sinon.SinonSpy
  // Stubs for private methods will be created on the instance
  let getProvidersFromFileStub: sinon.SinonStub
  let saveProvidersToFileStub: sinon.SinonStub

  setup(async () => {
    // Default to 'globalState' for providerStorageLocation
    getConfigurationStub = sinon.stub(vscode.workspace, "getConfiguration")
    getConfigurationStub.returns({
      get: sinon.stub().returns("globalState")
    } as any)

    globalStateGetStub = sinon.stub()
    globalStateUpdateStub = sinon.stub().resolves()

    context = {
      globalState: {
        get: globalStateGetStub,
        update: globalStateUpdateStub,
        keys: () => []
      },
      globalStorageUri: vscode.Uri.file("/mock/globalStorage")
    } as any

    postMessageSpy = sinon.spy()
    webview = {
      postMessage: postMessageSpy,
      onDidReceiveMessage: sinon.stub().returns({ dispose: sinon.spy() })
    } as any

    // Instantiate ProviderManager here so stubs for its methods can be added later if needed
    // The constructor of ProviderManager is now async due to _initializeProviders
    providerManager = new ProviderManager(context, webview)

    // Stub private methods AFTER instance creation
    // These are general stubs; specific tests will override their behavior.
    getProvidersFromFileStub = sinon.stub(providerManager as any, "_getProvidersFromFile")
    saveProvidersToFileStub = sinon.stub(providerManager as any, "_saveProvidersToFile")

    // Allow ProviderManager's async constructor to complete.
    // _initializeProviders is called in the constructor.
    // We need to ensure stubs are in place BEFORE _initializeProviders really runs.
    // A common pattern is to call an explicit init method, but here constructor does it.
    // For tests focusing on _initializeProviders, we might need to re-initialize or spy on it.
    // For now, let's assume default init (globalState, no providers) for basic tests.
    globalStateGetStub.withArgs(INFERENCE_PROVIDERS_STORAGE_KEY).returns(undefined)
    globalStateGetStub.returns(undefined) // Default for other keys
    getProvidersFromFileStub.resolves(undefined) // Default for file reads

    // Manually trigger initialization steps that would happen in constructor for testing purposes
    // if ProviderManager's constructor was more complex or if we needed to test re-initialization.
    // However, for this setup, the constructor will call _initializeProviders.
    // We might need to await on providerManager._initializeProviders() if it were public,
    // or use a small delay if truly necessary, but typically tests are synchronous after setup.
    // The key is that _initializeProviders will use the stubs we've set up.
    // Let's wait for any async operations in the constructor to settle.
    await providerManager['_initializeProviders']();
  })

  afterEach(() => {
    sinon.restore()
  })

  test("addProvider should set FIM provider as active when none exists", async () => {
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

    globalStateGetStub.withArgs(ACTIVE_FIM_PROVIDER_STORAGE_KEY).returns(undefined)
    globalStateGetStub.withArgs(INFERENCE_PROVIDERS_STORAGE_KEY).returns({})

    // Add the provider
    const result = await providerManager.addProvider(mockProvider)

    // Verify globalState.update was called for INFERENCE_PROVIDERS_STORAGE_KEY
    assert.ok(globalStateUpdateStub.calledWith(INFERENCE_PROVIDERS_STORAGE_KEY, sinon.match.object))
    // Verify globalState.update was called for ACTIVE_FIM_PROVIDER_STORAGE_KEY
    assert.ok(globalStateUpdateStub.calledWith(ACTIVE_FIM_PROVIDER_STORAGE_KEY, mockProvider))

    // Verify the provider was added and set as active
    assert.strictEqual(result?.type, "fim")
    // Check the arguments of the globalState.update call for active provider
    const activeProviderCall = globalStateUpdateStub.getCalls().find(call => call.args[0] === ACTIVE_FIM_PROVIDER_STORAGE_KEY);
    assert.ok(activeProviderCall, "ACTIVE_FIM_PROVIDER_STORAGE_KEY should have been updated");
    assert.deepStrictEqual(activeProviderCall.args[1], mockProvider);
  })

  test("addProvider should not override existing active FIM provider", async () => {
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

    globalStateGetStub.withArgs(ACTIVE_FIM_PROVIDER_STORAGE_KEY).returns(existingProvider)
    globalStateGetStub.withArgs(INFERENCE_PROVIDERS_STORAGE_KEY).returns({ [existingProvider.id]: existingProvider })

    // Add the new provider
    await providerManager.addProvider(newProvider)

    // Verify globalState.update was called for INFERENCE_PROVIDERS_STORAGE_KEY with the new provider
    assert.ok(globalStateUpdateStub.calledWith(INFERENCE_PROVIDERS_STORAGE_KEY, sinon.match(obj => obj[newProvider.id]?.id === newProvider.id)))
    // Verify globalState.update for ACTIVE_FIM_PROVIDER_STORAGE_KEY was NOT called with the newProvider,
    // meaning it was not overridden because one already existed.
    const activeProviderUpdateCall = globalStateUpdateStub.getCalls().find(call => call.args[0] === ACTIVE_FIM_PROVIDER_STORAGE_KEY);
    // It will be called initially by addDefaultProvider if nothing exists, so we check it wasn't called with newProvider
    assert.ok(activeProviderUpdateCall?.args[1].id === existingProvider.id || !activeProviderUpdateCall, "Active FIM provider should not have been overridden with the new provider if one already existed");
  })

  test("removeProvider should clear active provider when removing active FIM provider", async () => {
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

    globalStateGetStub.withArgs(ACTIVE_FIM_PROVIDER_STORAGE_KEY).returns(fimProvider)
    globalStateGetStub.withArgs(ACTIVE_CHAT_PROVIDER_STORAGE_KEY).returns(undefined)
    globalStateGetStub.withArgs(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY).returns(undefined)
    globalStateGetStub.withArgs(INFERENCE_PROVIDERS_STORAGE_KEY).returns({ [fimProvider.id]: fimProvider })

    // Remove the provider
    await providerManager.removeProvider(fimProvider)

    // Verify globalState.update was called to clear INFERENCE_PROVIDERS_STORAGE_KEY for that provider
    assert.ok(globalStateUpdateStub.calledWith(INFERENCE_PROVIDERS_STORAGE_KEY, sinon.match(obj => !obj[fimProvider.id])))
    // Verify globalState.update was called to clear ACTIVE_FIM_PROVIDER_STORAGE_KEY
    assert.ok(globalStateUpdateStub.calledWith(ACTIVE_FIM_PROVIDER_STORAGE_KEY, undefined))
  })

  test("Bug reproduction: Delete all providers, add new FIM provider should work", async () => {
    globalStateGetStub.withArgs(ACTIVE_FIM_PROVIDER_STORAGE_KEY).returns(undefined)
    globalStateGetStub.withArgs(ACTIVE_CHAT_PROVIDER_STORAGE_KEY).returns(undefined)
    globalStateGetStub.withArgs(ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY).returns(undefined)
    globalStateGetStub.withArgs(INFERENCE_PROVIDERS_STORAGE_KEY).returns({})

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

    const result = await providerManager.addProvider(newFimProvider)

    // Step 2: Verify the new provider is set as active
    assert.strictEqual(result?.type, "fim")
    assert.ok(globalStateUpdateStub.calledWith(ACTIVE_FIM_PROVIDER_STORAGE_KEY, newFimProvider))

    // For Step 3, getActiveFimProvider directly uses globalState.get, so we need to ensure our stub reflects the update
    globalStateGetStub.withArgs(ACTIVE_FIM_PROVIDER_STORAGE_KEY).returns(newFimProvider)
    const retrievedProvider = providerManager.getActiveFimProvider() // This call will use the stubbed get
    assert.deepStrictEqual(retrievedProvider, newFimProvider)
  })

  // New tests for storage mechanisms will go here
  describe("Provider Storage Mechanisms", () => {
    const sampleProvider1: TwinnyProvider = { id: "p1", label: "Provider 1", type: "chat", provider: "ollama", modelName: "m1" }
    const sampleProviders: Record<string, TwinnyProvider> = { [sampleProvider1.id]: sampleProvider1 }

    describe("Initialization and Migration", () => {
      test("should migrate from globalState to file if 'file' selected, no file exists, and globalState has data", async () => {
        getConfigurationStub.returns({ get: sinon.stub().returns("file") } as any)
        globalStateGetStub.withArgs(INFERENCE_PROVIDERS_STORAGE_KEY).returns(sampleProviders)
        getProvidersFromFileStub.resolves(undefined) // No file exists initially

        // Re-initialize ProviderManager to trigger _initializeProviders with new config
        providerManager = new ProviderManager(context, webview)
        // Stub private methods on the new instance
        sinon.stub(providerManager as any, "_getProvidersFromFile").resolves(undefined)
        const saveStub = sinon.stub(providerManager as any, "_saveProvidersToFile").resolves()
        await providerManager['_initializeProviders']();

        assert.ok(saveStub.calledOnceWith(sampleProviders), "_saveProvidersToFile should be called with migrated data")
        // Optional: Assert globalState was cleared if implementing that
        // assert.ok(globalStateUpdateStub.calledWith(INFERENCE_PROVIDERS_STORAGE_KEY, undefined))
      })

      test("should load from file if 'file' selected and file exists", async () => {
        getConfigurationStub.returns({ get: sinon.stub().returns("file") } as any)
        getProvidersFromFileStub.resolves(sampleProviders) // File exists and has data
        const globalStateGetSpy = sinon.spy(context.globalState, "get")

        providerManager = new ProviderManager(context, webview)
        sinon.stub(providerManager as any, "_getProvidersFromFile").resolves(sampleProviders)
        sinon.stub(providerManager as any, "_saveProvidersToFile").resolves()
        await providerManager['_initializeProviders']();

        const providers = await providerManager.getProviders()
        assert.deepStrictEqual(providers, sampleProviders)
        // Check INFERENCE_PROVIDERS_STORAGE_KEY was not the primary source after init
        const inferenceStorageCalls = globalStateGetSpy.getCalls().filter(call => call.args[0] === INFERENCE_PROVIDERS_STORAGE_KEY);
        // It might be called during migration check, so we ensure it's not the *final* source if file exists.
        // This assertion is tricky because of the migration path. A better check is that _getProvidersFromFile was used.
        assert.ok( (providerManager as any)._getProvidersFromFile.called, "_getProvidersFromFile should have been called");
      })

      test("should load from globalState if 'globalState' selected", async () => {
        getConfigurationStub.returns({ get: sinon.stub().returns("globalState") } as any)
        globalStateGetStub.withArgs(INFERENCE_PROVIDERS_STORAGE_KEY).returns(sampleProviders)

        providerManager = new ProviderManager(context, webview)
        // No need to stub file methods for this instance as they shouldn't be called.
        await providerManager['_initializeProviders']();

        const providers = await providerManager.getProviders()
        assert.deepStrictEqual(providers, sampleProviders)
        assert.ok(globalStateGetStub.calledWith(INFERENCE_PROVIDERS_STORAGE_KEY))
      })
    })

    describe("CRUD Operations", () => {
      describe("Storage: globalState", () => {
        beforeEach(async () => {
          getConfigurationStub.returns({ get: sinon.stub().returns("globalState") } as any)
          providerManager = new ProviderManager(context, webview)
          // Ensure private stubs are fresh if needed, though _saveProviders will internally branch
          getProvidersFromFileStub = sinon.stub(providerManager as any, "_getProvidersFromFile").resolves(undefined)
          saveProvidersToFileStub = sinon.stub(providerManager as any, "_saveProvidersToFile").resolves(undefined)
          await providerManager['_initializeProviders']();
        })

        test("addProvider saves to globalState", async () => {
          globalStateGetStub.withArgs(INFERENCE_PROVIDERS_STORAGE_KEY).returns({})
          await providerManager.addProvider(sampleProvider1)
          assert.ok(globalStateUpdateStub.calledWith(INFERENCE_PROVIDERS_STORAGE_KEY, sinon.match({ [sampleProvider1.id]: sampleProvider1 })))
          assert.ok(saveProvidersToFileStub.notCalled)
        })

        test("getProviders reads from globalState", async () => {
          globalStateGetStub.withArgs(INFERENCE_PROVIDERS_STORAGE_KEY).returns(sampleProviders)
          const providers = await providerManager.getProviders()
          assert.deepStrictEqual(providers, sampleProviders)
          assert.ok(getProvidersFromFileStub.notCalled)
        })
      })

      describe("Storage: file", () => {
        beforeEach(async () => {
          getConfigurationStub.returns({ get: sinon.stub().returns("file") } as any)
          providerManager = new ProviderManager(context, webview)
          getProvidersFromFileStub = sinon.stub(providerManager as any, "_getProvidersFromFile").resolves({}) // Start with empty file
          saveProvidersToFileStub = sinon.stub(providerManager as any, "_saveProvidersToFile").resolves()
          await providerManager['_initializeProviders']();
        })

        test("addProvider saves to file", async () => {
          await providerManager.addProvider(sampleProvider1)
          assert.ok(saveProvidersToFileStub.calledWith(sinon.match({ [sampleProvider1.id]: sampleProvider1 })))
          // INFERENCE_PROVIDERS_STORAGE_KEY might be updated for active providers, but not for the whole list
          const inferenceStorageWriteCall = globalStateUpdateStub.getCalls().find(call => call.args[0] === INFERENCE_PROVIDERS_STORAGE_KEY);
          assert.ok(!inferenceStorageWriteCall, "globalState should not be updated with the full provider list");
        })

        test("getProviders reads from file", async () => {
          getProvidersFromFileStub.resolves(sampleProviders)
          const providers = await providerManager.getProviders()
          assert.deepStrictEqual(providers, sampleProviders)
          const inferenceStorageReadCall = globalStateGetStub.getCalls().find(call => call.args[0] === INFERENCE_PROVIDERS_STORAGE_KEY);
          // It might be called during init for migration check. Focus on the fact that getProvidersFromFileStub was called for the actual get.
          assert.ok(getProvidersFromFileStub.called)
        })
      })
    })

    describe("resetProvidersToDefaults()", () => {
      const defaultProviderKeys = [
        ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
        ACTIVE_EMBEDDINGS_PROVIDER_STORAGE_KEY,
        ACTIVE_FIM_PROVIDER_STORAGE_KEY
      ];

      test("when 'file' storage, clears file and active globalState keys, then saves defaults to file", async () => {
        getConfigurationStub.returns({ get: sinon.stub().returns("file") } as any)
        providerManager = new ProviderManager(context, webview)
        getProvidersFromFileStub = sinon.stub(providerManager as any, "_getProvidersFromFile").resolves({})
        saveProvidersToFileStub = sinon.stub(providerManager as any, "_saveProvidersToFile").resolves()
        await providerManager['_initializeProviders']();

        await providerManager.resetProvidersToDefaults()

        // Check active keys in globalState are cleared
        for (const key of defaultProviderKeys) {
          assert.ok(globalStateUpdateStub.calledWith(key, undefined), `globalState key ${key} should be cleared`)
        }
        // Check file was "cleared" (saved with empty or default) then saved with new defaults
        assert.ok(saveProvidersToFileStub.calledWith({}), "Expected call to save empty object to file first")
        assert.ok(saveProvidersToFileStub.calledWith(sinon.match.object), "Expected call to save new defaults to file")
        // Ensure INFERENCE_PROVIDERS_STORAGE_KEY in globalState was not directly cleared (as we use file)
        const inferenceStorageClearCall = globalStateUpdateStub.getCalls().find(call => call.args[0] === INFERENCE_PROVIDERS_STORAGE_KEY && call.args[1] === undefined);
        assert.ok(!inferenceStorageClearCall, "INFERENCE_PROVIDERS_STORAGE_KEY in globalState should not be cleared when using file storage for the list itself.");
      })

      test("when 'globalState' storage, clears relevant globalState keys and saves defaults to globalState", async () => {
        getConfigurationStub.returns({ get: sinon.stub().returns("globalState") } as any)
        providerManager = new ProviderManager(context, webview)
        // No need to stub file methods for this instance
        await providerManager['_initializeProviders']();

        await providerManager.resetProvidersToDefaults()

        // Check active keys in globalState are cleared
        for (const key of defaultProviderKeys) {
          assert.ok(globalStateUpdateStub.calledWith(key, undefined))
        }
        // Check INFERENCE_PROVIDERS_STORAGE_KEY in globalState is cleared, then updated
        assert.ok(globalStateUpdateStub.calledWith(INFERENCE_PROVIDERS_STORAGE_KEY, undefined), "INFERENCE_PROVIDERS_STORAGE_KEY should be cleared first")
        assert.ok(globalStateUpdateStub.calledWith(INFERENCE_PROVIDERS_STORAGE_KEY, sinon.match.object), "INFERENCE_PROVIDERS_STORAGE_KEY should be updated with defaults")
        assert.ok(saveProvidersToFileStub.notCalled, "_saveProvidersToFile should not be called")
      })
    })
  })

  describe("Import/Export Providers", () => {
    let showSaveDialogStub: sinon.SinonStub
    let showOpenDialogStub: sinon.SinonStub
    let workspaceWriteFileStub: sinon.SinonStub
    let workspaceReadFileStub: sinon.SinonStub
    let showInfoMessageStub: sinon.SinonStub
    let showErrorMessageStub: sinon.SinonStub
    let getProvidersStub: sinon.SinonStub
    let saveProvidersStubManager: sinon.SinonStub // Renamed to avoid conflict with local var
    let getAllProvidersStubManager: sinon.SinonStub // Renamed

    const mockFileUri = vscode.Uri.file("/mock/providers.json")
    const sampleProvider1: TwinnyProvider = { id: "p1", label: "Provider 1", type: "chat", provider: "ollama", modelName: "m1" }
    const sampleProvider2: TwinnyProvider = { id: "p2", label: "Provider 2", type: "fim", provider: "ollama", modelName: "m2" }
    const sampleProvidersMap: Record<string, TwinnyProvider> = {
      [sampleProvider1.id]: sampleProvider1,
      [sampleProvider2.id]: sampleProvider2
    }

    beforeEach(() => {
      showSaveDialogStub = sinon.stub(vscode.window, "showSaveDialog")
      showOpenDialogStub = sinon.stub(vscode.window, "showOpenDialog")
      workspaceWriteFileStub = sinon.stub(vscode.workspace.fs, "writeFile").resolves()
      workspaceReadFileStub = sinon.stub(vscode.workspace.fs, "readFile")
      showInfoMessageStub = sinon.stub(vscode.window, "showInformationMessage")
      showErrorMessageStub = sinon.stub(vscode.window, "showErrorMessage")

      // Stub methods on the actual providerManager instance
      getProvidersStub = sinon.stub(providerManager, "getProviders")
      saveProvidersStubManager = sinon.stub(providerManager as any, "_saveProviders").resolves()
      getAllProvidersStubManager = sinon.stub(providerManager, "getAllProviders").resolves()
    })

    describe("exportProviders()", () => {
      test("Successful Export", async () => {
        getProvidersStub.resolves(sampleProvidersMap)
        showSaveDialogStub.resolves(mockFileUri)

        await providerManager.exportProviders()

        assert.ok(workspaceWriteFileStub.calledOnce)
        const writtenData = workspaceWriteFileStub.firstCall.args[1]
        const writtenJsonString = new TextDecoder().decode(writtenData)
        assert.deepStrictEqual(JSON.parse(writtenJsonString), sampleProvidersMap)
        assert.ok(showInfoMessageStub.calledWith("Providers exported successfully."))
      })

      test("Export Cancelled by User", async () => {
        getProvidersStub.resolves(sampleProvidersMap)
        showSaveDialogStub.resolves(undefined)

        await providerManager.exportProviders()

        assert.ok(workspaceWriteFileStub.notCalled)
        assert.ok(showInfoMessageStub.notCalled) // Or specific message if any
      })

      test("Export with No Providers", async () => {
        getProvidersStub.resolves({}) // Empty providers

        await providerManager.exportProviders()

        assert.ok(showInfoMessageStub.calledWith("No providers to export."))
        assert.ok(showSaveDialogStub.notCalled)
        assert.ok(workspaceWriteFileStub.notCalled)
      })
    })

    describe("importProviders()", () => {
      const validJsonString = JSON.stringify(sampleProvidersMap, null, 2)
      const validJsonUint8Array = new TextEncoder().encode(validJsonString)

      test("Successful Import (Replacing)", async () => {
        showOpenDialogStub.resolves([mockFileUri])
        workspaceReadFileStub.resolves(validJsonUint8Array)

        await providerManager.importProviders()

        assert.ok(saveProvidersStubManager.calledOnceWith(sampleProvidersMap))
        assert.ok(getAllProvidersStubManager.calledOnce)
        assert.ok(showInfoMessageStub.calledWith("Providers imported successfully."))
      })

      test("Import Cancelled by User", async () => {
        showOpenDialogStub.resolves(undefined)

        await providerManager.importProviders()

        assert.ok(workspaceReadFileStub.notCalled)
        assert.ok(saveProvidersStubManager.notCalled)
      })

      test("Import with Invalid JSON File", async () => {
        showOpenDialogStub.resolves([mockFileUri])
        const invalidJsonString = "{ bad json "
        const invalidJsonUint8Array = new TextEncoder().encode(invalidJsonString)
        workspaceReadFileStub.resolves(invalidJsonUint8Array)

        await providerManager.importProviders()

        assert.ok(showErrorMessageStub.calledWith(sinon.match(/Error parsing provider file:/)))
        assert.ok(saveProvidersStubManager.notCalled)
      })

      test("Import with data not conforming to Providers structure (e.g. array)", async () => {
        showOpenDialogStub.resolves([mockFileUri])
        const nonObjectData = JSON.stringify([{ id: "p1", label: "P1", modelName: "m1", provider: "ollama"}]);
        workspaceReadFileStub.resolves(new TextEncoder().encode(nonObjectData))

        await providerManager.importProviders()

        assert.ok(showErrorMessageStub.calledWith("Invalid provider file format: Not an object."))
        assert.ok(saveProvidersStubManager.notCalled)
      })

      test("Import with object but missing essential provider fields", async () => {
        showOpenDialogStub.resolves([mockFileUri])
        const missingFieldsData = JSON.stringify({ p1: { id: "p1", label: "P1" } }); // Missing modelName, provider
        workspaceReadFileStub.resolves(new TextEncoder().encode(missingFieldsData))

        await providerManager.importProviders()

        assert.ok(showErrorMessageStub.calledWith(sinon.match(/Provider with id 'p1' is missing essential properties/)))
        assert.ok(saveProvidersStubManager.notCalled)
      })
    })
  })
})
