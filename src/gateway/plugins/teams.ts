/**
 * The Microsoft Teams plugin: the notifier core posting an Adaptive Card,
 * which both a Workflows "post to a channel when a webhook request is
 * received" flow and the older Incoming Webhook connector accept.
 */
import type { PluginEvent } from "./events"
import type { GatewayPlugin } from "./host"
import { NotifierPlugin, NotifyHost } from "./notify"

const STYLE: Record<PluginEvent["level"], string> = { info: "good", warn: "warning", error: "attention" }

export const teamsPayload = (event: PluginEvent) => ({
  type: "message",
  attachments: [
    {
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        msteams: { width: "Full" },
        body: [
          { type: "TextBlock", text: event.title, weight: "Bolder", size: "Medium", wrap: true, color: STYLE[event.level] },
          ...(event.text.trim() ? [{ type: "TextBlock", text: event.text.trim(), wrap: true }] : []),
          { type: "TextBlock", text: `twinny-server · ${event.source}`, isSubtle: true, size: "Small", spacing: "Small" }
        ],
        ...(event.url ? { actions: [{ type: "Action.OpenUrl", title: "Open", url: event.url }] } : {})
      }
    }
  ]
})

export const teamsHost: NotifyHost = {
  id: "teams",
  urlExample: "https://….logic.azure.com/… or https://….webhook.office.com/…",
  payload: teamsPayload
}

export const teamsPlugin: GatewayPlugin = {
  id: "teams",
  name: "Microsoft Teams",
  description:
    "Post reviews, new pulls, failing checks, backups and backend outages to Teams channels as Adaptive Cards, through a Workflows webhook or an incoming webhook connector.",
  create: (context) => new NotifierPlugin(context, teamsHost)
}
