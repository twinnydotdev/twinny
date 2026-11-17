/**
 * The Slack plugin: the notifier core with Slack's message shape.
 * Mattermost and Rocket.Chat incoming webhooks take the same JSON and
 * render the same mrkdwn, so they work through this plugin too.
 */
import type { PluginEvent } from "./events"
import type { GatewayPlugin } from "./host"
import { NotifierPlugin, NotifyHost } from "./notify"

export { type Delivery, NotifierPlugin as SlackPlugin, WebhookStore,type WebhookView } from "./notify"

const ICONS: Record<PluginEvent["level"], string> = { info: ":white_check_mark:", warn: ":warning:", error: ":x:" }

/** Slack's mrkdwn: `*bold*`, `<url|label>`. Mattermost renders the same. */
/**
 * Text as Slack shows it, not as Slack obeys it: titles and summaries
 * carry a pull's title and a model's words, and an unescaped `<!channel>`
 * or `<https://…|label>` in them would ping or forge a link.
 */
const escapeSlack = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export const slackPayload = (event: PluginEvent): { text: string } => {
  const title = escapeSlack(event.title)
  // Only an http(s) address is a link; `|` and `>` in one would end it early.
  const url = event.url && /^https?:\/\/[^\s|<>]+$/.test(event.url) ? event.url : undefined
  const head = url ? `<${url}|${title}>` : title
  const lines = [`${ICONS[event.level]} *${head}*`]
  if (event.text.trim()) lines.push(escapeSlack(event.text.trim()))
  return { text: lines.join("\n") }
}

export const slackHost: NotifyHost = {
  id: "slack",
  urlExample: "https://hooks.slack.com/services/…",
  payload: slackPayload
}

export const slackPlugin: GatewayPlugin = {
  id: "slack",
  name: "Slack",
  description:
    "Post reviews, new pulls, failing checks, backups and backend outages to Slack channels through incoming webhooks. Mattermost and Rocket.Chat take the same messages.",
  create: (context) => new NotifierPlugin(context, slackHost)
}
