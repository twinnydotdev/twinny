/**
 * The Discord plugin: the notifier core with Discord's webhook shape, an
 * embed per event so the title links and the colour says the level.
 */
import type { PluginEvent } from "./events"
import type { GatewayPlugin } from "./host"
import { NotifierPlugin, NotifyHost } from "./notify"

/** Discord embed colours as decimal RGB. */
const COLOURS: Record<PluginEvent["level"], number> = {
  info: 0x23d18b,
  warn: 0xc98500,
  error: 0xe5484d
}

export const discordPayload = (
  event: PluginEvent
): { embeds: Array<{ title: string; url?: string; description?: string; color: number; footer: { text: string } }> } => ({
  embeds: [
    {
      title: event.title.slice(0, 256),
      ...(event.url ? { url: event.url } : {}),
      ...(event.text.trim() ? { description: event.text.trim().slice(0, 4096) } : {}),
      color: COLOURS[event.level],
      footer: { text: `twinny-server · ${event.source}` }
    }
  ]
})

export const discordHost: NotifyHost = {
  id: "discord",
  urlExample: "https://discord.com/api/webhooks/…",
  payload: discordPayload,
  checkUrl: (url) =>
    /(^|\.)discord(app)?\.com$/.test(url.hostname) && !url.pathname.startsWith("/api/webhooks/")
      ? "A Discord webhook URL looks like https://discord.com/api/webhooks/<id>/<token>: Server settings → Integrations → Webhooks."
      : undefined
}

export const discordPlugin: GatewayPlugin = {
  id: "discord",
  name: "Discord",
  description:
    "Post reviews, new pulls, failing checks, backups and backend outages to Discord channels through webhooks, as embeds that link back.",
  create: (context) => new NotifierPlugin(context, discordHost)
}
