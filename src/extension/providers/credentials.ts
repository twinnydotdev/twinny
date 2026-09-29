/**
 * Where a gateway token lives: VS Code's secret storage, keyed by the
 * provider it belongs to, never in the provider list (which is exported,
 * imported and may be a plain file).
 *
 * Requests need the token synchronously, so the store keeps every token
 * in memory once loaded and follows changes to secret storage.
 */
import { Disposable, ExtensionContext } from "vscode"

import { isRemoteProvider } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"

const SECRET_PREFIX = "twinny.gateway-token."

const cache = new Map<string, string>()

/** The stored token for a remote provider, if there is one. */
export const gatewayTokenFor = (providerId: string): string | undefined =>
  cache.get(providerId)

/**
 * A remote provider as a request should see it: the token typed in a form
 * wins, otherwise the stored one. Anything else passes through untouched.
 */
export const withGatewayToken = <T extends TwinnyProvider | undefined>(provider: T): T => {
  if (!provider || !isRemoteProvider(provider.provider) || provider.apiKey) return provider
  const token = gatewayTokenFor(provider.id)
  return token ? { ...provider, apiKey: token } : provider
}

export class RemoteCredentials implements Disposable {
  private readonly _listener: Disposable

  constructor(private readonly _context: ExtensionContext) {
    this._listener = _context.secrets.onDidChange((event) => {
      if (!event.key.startsWith(SECRET_PREFIX)) return
      void this._refresh(event.key.slice(SECRET_PREFIX.length))
    })
  }

  /** Fills the cache for every remote provider in the list. */
  public async load(providers: TwinnyProvider[]): Promise<void> {
    await Promise.all(
      providers
        .filter((provider) => isRemoteProvider(provider.provider))
        .map((provider) => this._refresh(provider.id))
    )
  }

  public has(providerId: string): boolean {
    return cache.has(providerId)
  }

  public get(providerId: string): string | undefined {
    return cache.get(providerId)
  }

  public async set(providerId: string, token: string): Promise<void> {
    await this._context.secrets.store(`${SECRET_PREFIX}${providerId}`, token)
    cache.set(providerId, token)
  }

  public async delete(providerId: string): Promise<void> {
    cache.delete(providerId)
    await this._context.secrets.delete(`${SECRET_PREFIX}${providerId}`)
  }

  public dispose() {
    this._listener.dispose()
  }

  private async _refresh(providerId: string) {
    const token = await this._context.secrets.get(`${SECRET_PREFIX}${providerId}`)
    if (token) cache.set(providerId, token)
    else cache.delete(providerId)
  }
}

/** For tests: forget every cached token. */
export const clearGatewayTokens = () => cache.clear()
