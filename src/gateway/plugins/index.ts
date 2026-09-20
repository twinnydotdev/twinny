/**
 * What this build carries. A plugin listed here appears in the admin
 * page's store, switched off until an admin turns it on.
 */
import { backupsPlugin } from "./backups"
import { bitbucketPlugin } from "./bitbucket"
import { contextPlugin } from "./context"
import { discordPlugin } from "./discord"
import { giteaPlugin } from "./gitea"
import { githubPlugin } from "./github"
import { gitlabPlugin } from "./gitlab"
import type { GatewayPlugin } from "./host"
import { oidcPlugin } from "./oidc"
import { slackPlugin } from "./slack"
import { teamsPlugin } from "./teams"

export const BUNDLED_PLUGINS: GatewayPlugin[] = [
  githubPlugin,
  gitlabPlugin,
  giteaPlugin,
  bitbucketPlugin,
  slackPlugin,
  discordPlugin,
  teamsPlugin,
  oidcPlugin,
  contextPlugin,
  backupsPlugin
]

export * from "./events"
export * from "./host"
