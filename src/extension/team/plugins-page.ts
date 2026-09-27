/**
 * Opens the team gateway's page for this developer: the plugins an admin
 * shared with them, such as pull requests with the gateway's reviews.
 *
 * The page signs in with a gateway key, and this developer's key lives in
 * VS Code's secret storage, where they cannot read it. It goes on the
 * clipboard for one paste rather than into the URL, where the browser's
 * history would keep it.
 */
import { commands, env, Uri, window } from "vscode"

import { TWINNY_COMMAND_NAME } from "../../common/constants"
import { gatewayPageLink, isPersonalKey } from "../../protocol/types"
import type { TeamSession } from "../providers/team"

export const openTeamPluginsPage = async (session: () => Promise<TeamSession | undefined>): Promise<void> => {
  const team = await session()
  if (!team) {
    const connect = "Open Providers"
    const choice = await window.showInformationMessage("Connect to your team's gateway first: its plugins open with your team key.", connect)
    if (choice === connect) await commands.executeCommand(TWINNY_COMMAND_NAME.manageProviders)
    return
  }
  if (!isPersonalKey(team.token)) {
    void window.showWarningMessage("Your team connection uses the shared token, which does not open the gateway's page. Ask your admin for a key of your own and connect with it.")
    return
  }
  await env.clipboard.writeText(team.token)
  await env.openExternal(Uri.parse(gatewayPageLink(team.url)))
  void window.showInformationMessage("Your team key is on the clipboard: paste it into the page to sign in, then copy something else over it. The page shows the plugins an admin shared with you.")
}
