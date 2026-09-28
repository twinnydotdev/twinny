/**
 * The team gateway's page, from VS Code: what an admin shared with this
 * developer (pull requests with the gateway's reviews, say) and a way in
 * that needs no key pasted anywhere.
 *
 * The developer's key lives in VS Code's secret storage, where they cannot
 * read it, and joining by invite never showed it to them. So opening the
 * page asks the gateway for a one-time code with that key and opens the
 * page with the code in the fragment; the page trades it for the key. An
 * older gateway without page links gets the key on the clipboard instead.
 *
 * Lives for the whole session: webviews come and go and read the status
 * through the bridge. A plugin newly shared with this developer is
 * announced once per gateway, with a button that opens it.
 */
import { authentication, Disposable, env, Event, EventEmitter, ExtensionContext, Uri, window } from "vscode"

import { TEAM_PLUGINS_SEEN_STORAGE_KEY } from "../../common/constants"
import { messageOf } from "../../common/errors"
import { logger } from "../../common/logger"
import type { TeamPluginsStatus } from "../../common/team"
import { RemoteInferenceProvider } from "../../protocol/client"
import { gatewayPageLink, GITHUB_LOGIN_PATTERN, isPersonalKey, PageLinkNames, signedInPageLink } from "../../protocol/types"
import { isInferenceError } from "../inference/errors"
import type { TeamSession } from "../providers/team"

/** How long a listing is trusted before a status read looks again. */
const LISTING_TTL_MS = 60_000
/** Back at the editor after this long, look again: the admin may have shared something meanwhile. */
const FOCUS_LOOK_MS = 5 * 60_000
/** How often a quiet window looks for newly shared plugins. */
const POLL_MS = 30 * 60_000
/** The first look waits for activation to settle. */
const FIRST_LOOK_MS = 5_000

/** What the service shows and opens; a test passes its own. */
export interface TeamPluginsUi {
  openExternal(target: Uri): Thenable<boolean>
  /** A notice with buttons; resolves with the one chosen, if any. */
  notify(message: string, ...actions: string[]): Thenable<string | undefined>
  /** Who the developer is on the hosts VS Code is signed in to, asked without a prompt. */
  names(): Promise<PageLinkNames>
}

/**
 * The GitHub login VS Code is signed in with, if any. Reading accounts
 * shows nothing and asks for nothing; with several accounts, the first.
 */
const githubLogin = async (): Promise<string | undefined> => {
  try {
    const accounts = await authentication.getAccounts("github")
    const login = accounts[0]?.label
    return login && GITHUB_LOGIN_PATTERN.test(login) ? login : undefined
  } catch {
    return undefined
  }
}

const editorUi: TeamPluginsUi = {
  openExternal: (target) => env.openExternal(target),
  notify: (message, ...actions) => window.showInformationMessage(message, ...actions),
  names: async () => {
    const github = await githubLogin()
    return github ? { github } : {}
  }
}

const EMPTY: TeamPluginsStatus = { available: false, sharedToken: false, admin: false, plugins: [] }

/** A gateway from before this route: 404, or the "Not found." an unknown route got. */
const missingRoute = (error: unknown): boolean =>
  isInferenceError(error) && (error.status === 404 || error.message === "Not found.")

/** Plugin names as a sentence: "GitHub", "GitHub and GitLab", "GitHub, GitLab and Gitea". */
export const listNames = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`

export class TeamPlugins implements Disposable {
  private readonly _onDidChange = new EventEmitter<TeamPluginsStatus>()
  public readonly onDidChange: Event<TeamPluginsStatus> = this._onDidChange.event
  private _status: TeamPluginsStatus = EMPTY
  private _checkedAt = 0
  private _checking?: Promise<void>
  private readonly _timers: ReturnType<typeof setTimeout>[] = []
  private readonly _focus: Disposable

  constructor(
    private readonly _context: ExtensionContext,
    /** Where the team is and the key that speaks for this developer there. */
    private readonly _session: () => Promise<TeamSession | undefined>,
    private readonly _ui: TeamPluginsUi = editorUi
  ) {
    this._timers.push(setTimeout(() => void this.refresh(true), FIRST_LOOK_MS))
    this._timers.push(setInterval(() => void this.refresh(true), POLL_MS))
    this._focus = window.onDidChangeWindowState((state) => {
      if (state.focused) void this.refresh(false, FOCUS_LOOK_MS)
    })
  }

  public status(): TeamPluginsStatus {
    return this._status
  }

  /** Looks at the gateway again when the last look is older than `maxAgeMs`, or now when forced. */
  public refresh(force = false, maxAgeMs = LISTING_TTL_MS): Promise<void> {
    if (this._checking) return this._checking
    if (!force && Date.now() - this._checkedAt < maxAgeMs) return Promise.resolve()
    this._checking = this.look().finally(() => {
      this._checking = undefined
      this._checkedAt = Date.now()
    })
    return this._checking
  }

  /** The team changed or was left: forget the old answer. */
  public async teamChanged(): Promise<void> {
    this._checkedAt = 0
    await this.refresh(true)
  }

  /**
   * Opens the gateway's page signed in, on `pluginId`'s page when given,
   * and says whether it did. Says what to do instead when there is no team
   * or no key of one's own. The developer's GitHub login rides along so
   * the page can fill in who they are there; the page never overwrites a
   * name already set.
   */
  public async open(pluginId?: string): Promise<boolean> {
    const team = await this._session()
    if (!team) {
      void window.showInformationMessage("Connect to your team's gateway first: its plugins open with your team key.")
      return false
    }
    if (!isPersonalKey(team.token)) {
      void window.showWarningMessage("Your team connection uses the shared token, which does not open the gateway's page. Ask your admin for a key of your own and connect with it.")
      return false
    }
    const view = pluginId ? `plugin:${pluginId}` : undefined
    const client = new RemoteInferenceProvider({ baseUrl: team.url, token: team.token })
    try {
      const [link, names] = await Promise.all([client.pageLink(), this._ui.names().catch((): PageLinkNames => ({}))])
      return await this._ui.openExternal(Uri.parse(signedInPageLink(team.url, link.code, view, names), true))
    } catch (error) {
      // A gateway from before page links: the key goes on the clipboard for one paste.
      if (missingRoute(error)) {
        await env.clipboard.writeText(team.token)
        await this._ui.openExternal(Uri.parse(gatewayPageLink(team.url)))
        void window.showInformationMessage("Your team key is on the clipboard: paste it into the page to sign in, then copy something else over it. Updating the gateway lets this open signed in.")
        return true
      }
      void window.showErrorMessage(`Could not open your team's page: ${messageOf(error)}`)
      return false
    }
  }

  public dispose() {
    for (const timer of this._timers) clearTimeout(timer)
    this._focus.dispose()
    this._onDidChange.dispose()
  }

  /* ------------------------------------------------------------------------ */

  private async look(): Promise<void> {
    const team = await this._session().catch(() => undefined)
    if (!team) return this.set(EMPTY)
    if (!isPersonalKey(team.token)) return this.set({ ...EMPTY, sharedToken: true, gateway: team.url })
    const client = new RemoteInferenceProvider({ baseUrl: team.url, token: team.token })
    try {
      const [identity, plugins] = await Promise.all([client.whoami(), client.sharedPlugins()])
      const admin = identity.admin === true
      this.set({ available: true, sharedToken: false, admin, gateway: team.url, plugins })
      if (!admin) this.announce(team.url, plugins)
    } catch (error) {
      // A gateway with no plugins, or from before sharing, has none to list; the page still opens.
      const missing = missingRoute(error) || (isInferenceError(error) && error.status === 403)
      this.set({ available: true, sharedToken: false, admin: false, gateway: team.url, plugins: [], ...(missing ? {} : { error: messageOf(error) }) })
      if (!missing) logger.info(`team plugins: ${messageOf(error)}`)
    }
  }

  private set(next: TeamPluginsStatus) {
    const changed = JSON.stringify(next) !== JSON.stringify(this._status)
    this._status = next
    if (changed) this._onDidChange.fire(next)
  }

  /** Tells the developer once about each plugin newly shared with them on this gateway. */
  private announce(gateway: string, plugins: TeamPluginsStatus["plugins"]) {
    const seenByGateway = this._context.globalState.get<Record<string, string[]>>(TEAM_PLUGINS_SEEN_STORAGE_KEY) ?? {}
    const seen = new Set(seenByGateway[gateway] ?? [])
    const fresh = plugins.filter((plugin) => !seen.has(plugin.id))
    // Remember what is shared now, so a plugin unshared and shared again is announced again.
    void this._context.globalState.update(TEAM_PLUGINS_SEEN_STORAGE_KEY, { ...seenByGateway, [gateway]: plugins.map((plugin) => plugin.id) })
    if (!fresh.length) return
    const open = "Open"
    const names = listNames(fresh.map((plugin) => plugin.name))
    void this._ui
      .notify(`Your team shared ${names} with you on the gateway. Open it signed in, no key needed.`, open)
      .then((choice) => {
        if (choice === open) void this.open(fresh[0].id)
      })
  }
}
