/**
 * The admin page's HTML shell. The React app and its stylesheet are
 * inlined at build time (`scripts/build.mjs` bundles `ui/` to strings), so
 * the page is one response with no assets and no network beyond the
 * gateway's own API.
 */
import { REMOTE_PROTOCOL_VERSION } from "../protocol/types"

declare const __TWINNY_ADMIN_JS__: string
declare const __TWINNY_ADMIN_CSS__: string

const js = typeof __TWINNY_ADMIN_JS__ === "string" ? __TWINNY_ADMIN_JS__ : ""
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
${js ? `<script>${js.replace(/<\/script/gi, "<\\/script")}</script>` : ""}
</body>
</html>
`
