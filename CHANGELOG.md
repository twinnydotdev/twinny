# Changelog

What changed in each release of the twinny extension and `twinny-server`. The gateway is built from the same tree and carries the extension's version number. Newest first. A shorter, feature-by-feature version with links to the documentation is at [What's new](https://docs.twinny.dev/reference/whats-new/).

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
