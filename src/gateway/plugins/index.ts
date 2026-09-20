/**
 * What this build carries. A plugin listed here appears in the admin
 * page's store, switched off until an admin turns it on.
 */
import { backupsPlugin } from "./backups"
import { githubPlugin } from "./github"
import { gitlabPlugin } from "./gitlab"
import type { GatewayPlugin } from "./host"
import { slackPlugin } from "./slack"

export const BUNDLED_PLUGINS: GatewayPlugin[] = [githubPlugin, gitlabPlugin, backupsPlugin, slackPlugin]

export * from "./events"
export * from "./host"
