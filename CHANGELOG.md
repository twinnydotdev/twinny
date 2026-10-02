# Changelog

What changed in each release of the twinny extension and `twinny-server`. The gateway is built from the same tree and carries the extension's version number. Newest first. A shorter, feature-by-feature version with links to the documentation is at [What's new](https://docs.twinny.dev/reference/whats-new/).

## 4.3.2 · 2026-10-02

Extension release: agent mode's steps show inside the reply, commands run in the background with their output in the chat, and commands can be approved from the keyboard. `twinny-server` carries the version number only.

- **Steps show where they happened in the reply.** Before, every tool step sat in one block above the reply, so a command waiting for Run was above the text you were reading. Now the reply reads in order: what the model said, the tool it used, what it said next. A command waiting for you is at the bottom, where you are already looking. Conversations saved earlier show their steps at the top, as before.
- **Commands run in the background, with their output in the chat.** A command the model runs no longer opens the **twinny tools** terminal. It runs through `bash` from the workspace root, and its output appears in its step as it prints. Nothing can answer a prompt, and a command is stopped after two minutes, so interactive commands, servers and watch modes belong in a terminal. Set `twinny.chatToolsCommandsRunIn` to `terminal` to run them in the terminal as before.
- **An auto-run switch.** With agent mode on, an **auto-run** switch next to the agent switch lets every command run without asking. Until you first flip it, `twinny.chatToolsCommands` decides, so commands still ask by default.
- **Always run, one command at a time.** A waiting command now has **Always run** between Run and Skip. It runs the command and remembers that exact command, so the model can run it again without asking; any other command still asks. **Twinny - Forget commands set to always run** clears the list.
- **Approve from the keyboard.** When a command or change is waiting and the composer is empty, `Enter` runs or applies it, `Shift+Enter` always runs it, and `Esc` skips it. A second `Esc` still stops the reply.
- **Stop one command, not the whole reply.** A running command has a stop button on its line. It ends that command and anything it started; the model gets the output so far, is told you stopped it, and carries on.
- **Model names fit in the composer footer, and nothing overlaps in a narrow panel.** The provider dropdown takes only the room it needs, and the model's name gets the rest. As the panel narrows, "? for shortcuts" shrinks to "?", the agent switch drops its key hint, auto-run keeps only its icon, and the placeholder is cut short on one line. The switches no longer run under the camera and send buttons, and the dropdown arrows no longer cover the names.

## 4.3.1 · 2026-10-01

Extension release: code in agent mode's steps wraps properly. `twinny-server` carries the version number only.

- **Code in tool steps reads as code again.** A file the agent read, shown with line numbers in a narrow chat, broke every word into its own wrapped column. Long lines now wrap as text, under the code and clear of the line numbers.

## 4.3.0 · 2026-10-01

Extension release: agent mode switched from the chat, messages queued while a reply runs, terminal-style chat keys, and a fix for Anthropic tool calls. `twinny-server` carries the version number only.

- **Messages sent while a reply runs are queued, not lost.** Pressing Enter while the model is answering, or working through tools in agent mode, used to clear what you typed without sending it. It now waits under the transcript, marked *queued*, and goes out when the reply ends, one message per reply. Hover a queued message to drop it. Stopping the reply (`Esc`, `Ctrl+C` or the stop button) puts queued messages back in the composer instead of sending them.
- **Agent mode with Anthropic no longer fails after a tool with no arguments.** When Claude called a tool that takes nothing, such as looking at the editor, the next step failed with "Unexpected end of JSON input" before it was sent. Calls with no arguments now go back as `{}`; Bedrock, Gemini and Cohere had the same failure.
- **Agent mode, one key away.** A switch at the bottom left of the chat's composer, or `Shift+Tab`, turns agent mode on and off: the model may then read, search and edit files and run commands in the workspace. The choice is kept for every window; until you first switch it, the `twinny.chatTools` setting decides. While it is on, the prompt turns to a bright `❯❯`, and it pulses while the model works.
- **Chat keys, as in a terminal.** `Ctrl+C` stops a reply, or clears the draft when nothing is streaming; with text selected it still copies. `Esc` twice clears the draft, and `↑` brings a cleared draft back. `Ctrl+L` starts a new conversation, `PgUp` and `PgDn` scroll the transcript from the composer, and typing with the focus on the transcript goes to the composer. `Esc` and `Ctrl+C` stop a reply from anywhere in the chat, not only the composer. Press `?` on an empty composer for the list, or run **Twinny - Chat keyboard shortcuts** from the view's `…` menu.

## 4.2.10 · 2026-09-30

Extension release: twinny starts in WSL again, and the Embeddings tab holds still while indexing.

- **Works in WSL remotes.** Opening a folder through WSL failed activation with `Cannot read properties of undefined (reading 'header')`, so chat never loaded and completions did nothing. LanceDB's native loader read the Node process report to tell glibc from musl, and the VS Code server under WSL returns none. The check now falls back to glibc, and LanceDB loads when the index is first opened rather than at startup, so a native module that fails to load turns embeddings off instead of stopping the extension.
- **No flicker while indexing.** The line naming the files being embedded came and went between files, making the page below it jump many times a second. It now keeps its place for the whole run.

## 4.2.9 · 2026-09-29

`twinny-server` release: `twinny-server --version` and the gateway's `/twinny/v1` responses report the right version. The 4.2.8 package was published with a bundle built before the version bump, so it called itself 4.2.7. Publishing now refuses a `cli.js` that was not built for the package's version.

## 4.2.8 · 2026-09-28

Extension and `twinny-server` release: plugins shared with developers, opened from VS Code already signed in, an approve button on the pull page, and Qwen3-Coder completions through a gateway.

- **Share plugins with developers.** An admin can share a plugin with every developer or with the people they tick, from the plugin's card under **Plugins → Store** or `PUT /twinny/v1/admin/plugins/<id>/access`. A developer then signs in to the gateway's page with their own key and sees only the plugins shared with them, without their settings. On GitHub, GitLab, Gitea and Bitbucket they read pulls and issues, review, ask about a review, post it as a comment, triage and apply the suggested labels, and set their own username on the host; approving or requesting changes through the token stays with admins, as do repositories, tokens, the GitHub App and the review model. The notifiers, SSO sign-in, shared context and backups are for admins only. Grants are kept by key name in `plugins.json`, every change is audited (`plugin.access-changed`), and a developer's writes are audited under their name, marked `member`. The shared token and a demo's guests never open a plugin.
- **Your team's plugins, one click from VS Code, signed in.** When an admin shares a plugin with you, VS Code says so once with an **Open** button, and the Providers tab lists it under **Your team's plugins**; admins get **Your gateway's page**. Opening asks the gateway for a one-time code with your key (`POST /twinny/v1/page-link`) and opens the page with the code in the URL fragment; the page trades it for the key once, within a minute (`POST /twinny/v1/page-link/open`), and wipes it from the address bar. Nobody sees, copies or pastes a key, and a developer who joined by invite needs nothing from the admin. **Twinny - Open your team's plugins** in the command palette does the same; against an older gateway it falls back to putting the key on the clipboard.
- **The page knows who you are on GitHub.** Opened from VS Code, the page fills in your GitHub username from the account VS Code is signed in with, once, so pull requests waiting for your approval appear under **waiting for me**; it never replaces a name you set and is skipped on GitHub Enterprise. Without one, the plugin's page asks **Who are you on GitHub?** at the top until you answer.
- **Approve from the pull page.** An admin approves a pull request with one button next to its checks, as the repository's token, with no review text posted. GitHub, Gitea and GitLab pin the approval to the commit the page showed. Developers a plugin is shared with do not get the button.
- **Qwen3-Coder completions through a gateway.** A chat-only FIM model's prompt now reaches `twinny-server` as the chat it was rendered from, instead of being refused, so the backend no longer templates it twice.

## 4.2.7 · 2026-09-24

Extension and `twinny-server` release: the completion model is loaded before you type, and the gateway shields secrets for every client.

- **The completion model is loaded before you type.** When VS Code starts or regains focus, twinny asks a local model server (Ollama, LM Studio, llama.cpp, or an OpenAI-compatible server on this machine) to load the autocomplete model, so the first completion no longer waits for it. With CodeLlama 7B on Ollama, the first completion went from 11 to 17 seconds to 0.06. Nothing is sent when the model has been used in the last four minutes, and hosted APIs are never called. Turn it off with `twinny.warmUpModel`.
- **The gateway shields secrets too.** `twinny-server` now swaps credentials in prompts for placeholders before a request reaches a backend, and puts them back in the reply, for every client (the extension, the TUI, Neovim). Set it with `policy.secretShield` or on the admin page's **Policy** tab: `offMachine` (the default) covers hosted APIs, backends on other hosts and the team pool; `always` adds backends on the gateway's own host; `off` forwards prompts as they arrive.

## 4.2.6 · 2026-09-24

Extension release: a secret shield keeps credentials out of prompts that leave the machine. `twinny-server` carries the version number only.

- **Secret shield.** API keys, tokens, private keys and passwords in a prompt are replaced with placeholders such as `REDACTED_GITHUB_TOKEN_1` before the request leaves your machine, and put back wherever the reply uses them, so the model never sees the value and the code it writes still works. This covers chat, completions, inline edit and embeddings. It knows the GitHub, GitLab, AWS, Stripe, Slack, OpenAI, Anthropic, Google, Hugging Face and npm token formats, as well as PEM private keys, JWTs, passwords in URLs, and secret-named values in code and `.env` files. Values like `process.env.X` or `<your-key>` are left alone. A chat reply shows **N secrets withheld** and which kinds; completions log it to the Twinny output channel. The `twinny.secretShield` setting controls when it runs: `offMachine` (the default) covers hosted APIs, gateways, paired devices and servers elsewhere on the network, `always` adds local servers, and `off` turns it off.

## 4.2.5 · 2026-09-23

Gateway release: pull-request reviews stop ending mid-sentence, say when they were cut, and can be asked about. The extension carries the version number only.

- **Reviews no longer end mid-sentence.** Ollama's OpenAI-compatible route ignores `think: false` (checked against 0.33), so a reasoning model such as Qwen 3 thought its way through most of the 4,000-token budget and the review that followed was cut off. The request now says it the standard OpenAI way, `reasoning_effort: "none"`, which that route does honour; the extension's chat and developers' requests through the gateway are unchanged.
- **A cut-off answer says so.** Backends now report why generation stopped, and a review or answer the output cap cut is kept but tagged **cut short**, with the reason (and how much went on thinking) above it.
- **Ask about a review.** Under a finished review is a box for questions. Each goes to the review model with the pull, the review and the earlier questions, and the exchange is kept on the review as a thread until the pull is reviewed again. Nothing in it is posted to the host. Route: `POST …/pulls/<n>/review/ask { question }`.

## 4.2.4 · 2026-09-23

Chat release: replies carry their details, and the chat gains the controls it was missing. `twinny-server` carries the version number only; the gateway is unchanged.

- **Replies say who wrote them.** Under each reply: the model, how long it took and, when the backend reports token counts, tokens per second. A reply you stopped says so. The details are saved with the conversation and never sent to the model; older conversations show nothing.
- **Continue a stopped reply.** The last reply, if you stopped it, has a *Continue* button that asks the model to carry on without starting over.
- **Earlier prompts with ↑ and ↓.** From an empty composer, the arrow keys step through what you have sent, across conversations, as in a shell. Typing into a recalled prompt makes it your draft.
- **Esc stops a reply** while the composer has focus.
- **Insert at cursor.** Code blocks in replies have *insert* next to *apply*: the code goes straight into the editor at the cursor, replacing any selection. *Apply* still proposes a diff to review.
- **Open conversation as Markdown**, from the sidebar's `…` menu or the panel's toolbar: the whole conversation in a new editor, without thinking or composer markup.
- **Long questions fold.** A message of yours taller than about a dozen lines (an *Explain* over a big selection, pasted code) shows its first lines and *Show more*.
- **Empty code blocks are not shown.** A fence with only whitespace in it no longer renders as an empty box with buttons.
- **The sidebar keeps its state when hidden.** Switching to another view and back no longer reloads the chat, so a half-written prompt, a reply still streaming and the scroll position survive.

## 4.2.3 · 2026-09-23

Small release: code completion works with Qwen3-Coder. `twinny-server` carries the version number only; the gateway is unchanged.

- **Qwen3-Coder completes code.** Qwen3-Coder is released only as an instruct model, and it fills the hole when the FIM prompt arrives as the user turn of a chat ("You are a code completion assistant."). Twinny sent it the bare Qwen2.5-Coder markers, and plain text at the end of a file, so completions came back as garbage. Models whose name contains `qwen3-coder` now get a new `qwen3-coder` FIM template, which is also in the template list. Completion endpoints still get a completion request: the chat is written out as ChatML in the prompt, and Ollama is sent `raw: true` so it does not apply the model's template a second time. LiteLLM gets the chat as messages. Custom and repository-level templates are wrapped the same way. The model answers inside a markdown code block whatever the system prompt says, so for this template the opening fence is dropped and the closing one ends the completion. Given a half-typed word the model either repeats it (`c` completed with `const mul`, shown as `cconst`) or starts a fresh line after it, so for this template the prompt now ends before the unfinished word, the chat names what the completion must begin with, and an answer that ignores it is discarded. A short echoed word start is stripped for every model.
- **A suggestion made in an empty file no longer follows what you type.** The last suggestion shown is kept so that typing its first characters serves the rest without a new request. At the start of a file it had nothing to anchor to and was re-served after any text at all, whether or not the completion cache was on.

## 4.2.2 · 2026-09-23

Small release: prompt templates (`~/.twinny/templates`) are sturdier. `twinny-server` carries the version number only; the gateway is unchanged.

- **A missing or broken template no longer breaks the feature.** Deleting `system.hbs` used to make every template render empty, so Explain, Review and the commit message all failed. A template that is missing, blank or will not parse now falls back to the built-in copy, and the reason goes to the Twinny output channel. Asking for a template that does not exist returns nothing instead of throwing in the background.
- **Prompts are no longer HTML-escaped.** A review of "Fix `<T>` & co" reached the model as `Fix &lt;T&gt; &amp; co`; values now go in as written.
- **The template buttons in chat** no longer offer *review-summary*, which needs a review to summarise, and a template of your own whose name merely starts with "system" is listed again.
- Template names that are not plain file names are refused, and the `eq` helper is available to every template however the extension started.

## 4.2.1 · 2026-09-22

Small release: the extension tells the person who could run a gateway that one exists, and the listings say what the product costs.

- **Set up for your team.** The Providers tab has a second team card for whoever has the models: the quick-start command and a link to the gateway page on twinny.dev. The same link is the command *Twinny - Set up for your team*.
- **One notice, once.** Two weeks after first use on a machine that is not connected to a team, one information message says the gateway exists, with *See how* and *No thanks*. It is recorded as shown before it appears, so dismissing it is also the end of it. A machine connected to a team never sees it.
- The Marketplace description and both READMEs name the team gateway, the price, and the free 30-day trial at twinny.dev. `twinny-server` is republished for its README only; the gateway itself is unchanged.

## 4.2.0 · 2026-09-21

Everything in it is on the gateway side; the extension only learns to send the open workspace's name (for routing rules) and to search the shared context index.

### Plugins

Plugins are features the gateway ships with but that stay off until an admin switches them on from **Plugins → Store** on the admin page. Each has its own routes, files and page. They are a licence feature: without one the store lists them but none can be switched on, and plugins that were on stop when a licence lapses and start again when one is installed.

- **GitHub and GitLab pull requests.** Watch repositories with a token or a GitHub App and the admin page lists every open pull request across them: checks, merge state, review state, drafts. Open one to read the description and highlighted diffs. **Review now** sends it to one of the gateway's own chat aliases and keeps the review on the server; **auto-review** does it in the background for new and updated pulls while no developer request is running.
- **Gitea, Forgejo, Codeberg and Bitbucket Cloud** on the same pull-request core.
- **Reviews posted back to the host** as a comment, a change request or an approval, with a footer naming the model; **auto-post** per repository. A review in progress shows as a status row.
- **Issue triage.** Open issues are listed beside pulls; a model suggests labels, a duplicate, a priority and a first reply, kept on the server until someone posts the reply or applies the labels. Auto-triage suggests while the models are idle.
- **Pull-request pages** have one listing toolbar on every forge: one-click views with live counts, selects for repository, author, label, target branch and activity, a search, order by, sortable headers, all remembered per host. Each pull carries its approvals as the host reports them, and the page tags each pull with the operator's part in it ("waiting for me"). Drafts stay out of the list until a toggle brings them in.
- **Reasoning models** are asked not to think when reviewing (`think: false` on Ollama); reasoning deltas and inline `<think>` blocks are recognised, and a thinking-only answer fails with the reason.
- **Slack, Discord and Microsoft Teams** post chosen events to webhooks (Mattermost and Rocket.Chat take the Slack shape): a review finished or asked for changes, a pull opened, checks failed, a backup made or failed, a backend down or back. A test button and a delivery log per webhook; URLs are kept secret. Plugins share one event bus.
- **SSO sign-in (OIDC).** Developers sign in with Okta, Entra ID, Google Workspace, Keycloak or any OpenID Connect provider: PKCE, nonce, RS256 id_token verified against the provider's keys, a domain allow-list, admin emails, and a key minted through a replacing invite that opens VS Code. Signing in again replaces the key, so it doubles as lost-key recovery.
- **Shared context.** Repositories are cloned shallow onto the gateway, chunked, embedded with an embeddings alias it serves, and re-indexed on a schedule while the models are idle, embedding only what changed. Connected extensions search it with their key and merge the hits into the relevant code their chat already gathers.
- **Backups.** A nightly copy of configuration, keys, licence, invites, plugins and usage (recordings on request) to a directory or an S3-compatible bucket, optionally encrypted, with retention and a CLI restore (`twinny-server backup restore`).
- Plugin logos on the store, navigation and pages; skeleton loaders while a page loads; themed scrollbars on panels and code blocks.

### Gateway operations

- **Audit log.** Every admin change (keys, invites, sign-ins, configuration, licence, plugins on or off, plugin writes) goes to `audit/YYYY-MM.jsonl`, each line carrying the hash of the line before it. **Team → Audit log** shows whether the chain is intact, filters by period, actor and kind, and exports.
- **Read-only admins.** `keys create <name> --admin --read-only` (or the box on People) opens the admin page and every `GET` admin route and refuses anything that changes state.
- **Prometheus metrics** at `GET /metrics` for admin keys: requests by route, alias and outcome, a latency histogram, tokens, in-flight and queued requests, backend health, refused authentications, seats, plugin events.
- **Costs.** Give an alias a price per million input and output tokens and a currency, and Usage and Overview show what each developer, model and period cost.
- **Bounded request queue.** A chat or autocomplete request that finds every slot taken waits, oldest first, for up to `limits.queue.fimWaitMs` or `chatWaitMs` before it is refused; at most `limits.queue.maxWaiting` may wait. A client that goes away while waiting is dropped as `request.abandoned`. Refusal logs say whether the gateway, the queue or the key's own limit refused; `twinny_queued_requests` is exported.
- **Data-directory format marker.** `format.json` names the layout; migrations run in order at start, a newer format than the build knows exits with code 6, and a directory with files but no marker is taken as format 1. Backups carry the marker along.
- **Routing rules** in team policy keep a workspace on local backends or on named aliases, matched on the workspace name the extension now sends. **Team system prompt** in policy is put before every chat's system prompt on connected extensions and shown on the consent card.
- **Helm chart** under `deploy/helm/twinny-server`: one pod, one volume, an optional Ingress with TLS, a ServiceMonitor for `/metrics`.
- The admin shell widens to 1480px and folds the sidebar into tabs below 960px.

## 4.1.3 · 2026-09-18

- Gateway discovery now names the backend model behind each alias, and the extension picks the fill-in-the-middle prompt format from it instead of from the alias name. An alias called `coder` in front of Codestral gets the Codestral format.

## 4.1.2 · 2026-09-18

- Mistral: the completion endpoint gets the model in the request body, and text-only chat messages go as a plain string rather than a parts list, which Mistral refused. Images keep their parts.

## 4.1.1 · 2026-09-18

Teams. One gateway on your own hardware serves twinny to the whole team.

- **`twinny-server`**, a dependency-free Node package built from `src/gateway`: `quickstart` finds a local model server, writes a configuration, makes an admin key and serves; `init`, `serve`, `keys`, `invites`, `usage`, `license`, `recordings`, `reset`. Any OpenAI-compatible backend, Ollama, LM Studio, llama.cpp, QVAC or a hosted API behind named aliases.
- **Protocol v1** at `/twinny/v1`: models, chat, fim and embeddings streamed as NDJSON, with typed error kinds; the extension's **Twinny gateway** provider speaks it with a token kept in VS Code secret storage.
- **A key per developer**, stored as a hash, created and revoked live on the admin page or the CLI; per-key limits; a shared token that can be retired.
- **Invite links** (`vscode://` URI handler) that open VS Code and connect with nothing to paste; one use, seven days, no seat until opened. Sign-in with a short code as the alternative.
- **Usage per person and per model**: requests, failures, token counts, indexing runs; retention you choose; never the content.
- **Admin page** at `/admin`: overview, usage charts, people, policy, providers and models (edited live), plan and licence, recordings.
- **Team GPU pooling.** A developer flips *Share this computer* and their local server serves the team through a WebSocket to the gateway: no port to open, consent shown, least-loaded first, failover when a sharer goes offline.
- **Seat licensing.** Five seats free for good; a signed `twl1.` token bought by card raises the count and switches on policy and recording. Checked locally, no call home, 30-day notice and 14-day grace.
- **Team policy** (licence): team-gateway-only providers and locked defaults, shown for consent before connecting and enforced by the extension while connected. **Leave team** is one click.
- **Recording** (licence): keep chat, autocomplete and embedding content on the gateway, disclosed to every developer, reviewed and exported as training data from the admin page.
- **Docker** image `ghcr.io/twinnydotdev/twinny-server` with a compose file; **demo mode** (`serve --demo`) for a read-only public admin page with one-hour guest keys.
- Autocomplete fix: a client that hung up after the first chunk no longer logs the request as cancelled.

## 4.0.20 · 2026-09-17

- Chat: *Add file to context* did nothing (#503).

## 4.0.19 · 2026-09-14

- Chat: code blocks render and copy better.

## 4.0.14 to 4.0.18 · 2026-09-13

- **Workspace index**: models that truncate at 256 tokens are given embedding windows instead of whole chunks; identifiers are split for the keyword column; follow-up questions search with their question; open files are favoured; hits are widened to neighbours. Workspace search sources show under chat replies.
- **Autocomplete** gets the definitions and signatures of what is being typed from the language server.
- **Providers**: validation, a *Test provider* probe on every card, presets, import and export; the provider layer is laid out by feature.
- Logging through a VS Code `LogOutputChannel`.

## 4.0.10 to 4.0.13 · 2026-09-10 and 11

- **Mentions**: `@git`, `@terminal` and `@symbol` join `@files`, `@problems` and `@workspace`.
- **Terminal**: *fix the last error* with the output attached, and write a command from a description, shown before it runs. Needs VS Code 1.93 shell integration.
- **Workspace index** rewritten: an incremental index with a manifest, hybrid BM25 and vector search, a reranker in worker threads, `@workspace` or automatic mode.
- Dependencies updated.

## 4.0.7 to 4.0.9 · 2026-09-07 and 08

- **Inline edit**: Ctrl+I streams a merged diff into the editor with Accept and Reject per hunk (CodeLens and keys); *Fix with Twinny* quick fix.
- **Autocomplete** takes context from the language server and from recent edits (diff hunks against a baseline per document).
- Tests written next to the code they cover.

## 4.0.0 to 4.0.6 · 2026-09-07

The 4.x rewrite.

- **Autocomplete** rebuilt: a per-request completion stream with a termination policy (stop words, blank line, dedent, bracket depth, suffix duplicate, max lines), type-through continuation, stop sequences sent server-side, plain continuation at end of file, imports first in the context budget. Template bugs for qwen2.5-coder, CodeGemma and DeepSeek fixed.
- **Devices**: use the GPU in another of your computers over an encrypted peer-to-peer link with a pairing code; no account, no relay. Symmetry is removed.
- **First run** discovers a local model server instead of assuming Ollama; a welcome view and a reset command.
- **Next edit** as its own provider type for the Sweep next-edit model.
- **QVAC** located at runtime with an in-tab install guide.
- Status bar rewritten; the commit-message command restored; chat lifecycle and error fixes; macOS 15 Intel build.
