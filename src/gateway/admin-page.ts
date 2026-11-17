/**
 * The admin page's HTML shell. The React app and its stylesheet are
 * inlined at build time (`scripts/build.mjs` bundles `ui/` to strings), so
 * the page is one response with no assets and no network beyond the
 * gateway's own API.
 */
import { createHash } from "node:crypto"

import { REMOTE_PROTOCOL_VERSION } from "../protocol/types"

declare const __TWINNY_ADMIN_JS__: string
declare const __TWINNY_ADMIN_CSS__: string

// A closing script tag inside the bundle would end the element early.
const js = (typeof __TWINNY_ADMIN_JS__ === "string" ? __TWINNY_ADMIN_JS__ : "").replace(/<\/script/gi, "<\\/script")
const css = typeof __TWINNY_ADMIN_CSS__ === "string" ? __TWINNY_ADMIN_CSS__ : ""

const FALLBACK = `<main class="signin"><section class="card"><h1>twinny-server</h1>
<p>The admin page was not bundled into this build. Run <code>npm run build</code> in the repository and use the packaged <code>cli.js</code>.</p></section></main>`

/** `demo` tells the app to open as the read-only visitor instead of asking for a key. */
export const adminPageHtml = ({ demo = false } = {}): string => `<!doctype html>
<html lang="en" data-protocol="${REMOTE_PROTOCOL_VERSION}"${demo ? " data-demo=\"1\"" : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${demo ? "" : "<meta name=\"robots\" content=\"noindex\">"}
<title>twinny-server</title>
<style>${css}</style>
</head>
<body>
${js ? "<div id=\"root\"></div>" : FALLBACK}
${js ? `<script>${js}</script>` : ""}
</body>
</html>
`

const sha256 = (text: string): string => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`
const SCRIPT_HASH = js ? sha256(js) : "'none'"

/**
 * The page's response headers. Only the bundled script runs: it is named
 * by its hash, so markup that reached the page some other way (a pull's
 * title, a model's answer) cannot bring a script with it, and nothing is
 * fetched from anywhere but this gateway. Styles stay inline because the
 * code highlighter sets them per token. The demo may be framed by the
 * site that shows it; a real gateway's page may not be framed at all.
 */
export const adminPageHeaders = ({ demo = false } = {}): Record<string, string> => ({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'none'",
    `script-src ${SCRIPT_HASH}`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src data:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    ...(demo ? [] : ["frame-ancestors 'none'"])
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  ...(demo ? {} : { "X-Frame-Options": "DENY" })
})
