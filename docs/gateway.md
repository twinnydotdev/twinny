# Twinny gateway (`twinny-server`)

A standalone process that serves configured models to Twinny extensions over
HTTP. Inference runs on the machine with the models; VS Code runs anywhere
that can reach the gateway with its access token.

```
Twinny extension → "Twinny gateway" provider → Twinny remote protocol v1
                 → twinny-server → inference adapter → your backend (Ollama, LM Studio, …)
```

The gateway is the `twinny-server` npm package, built from `packages/twinny-server`
in this repository as a single file with no runtime dependencies. It needs
Node 18 or newer and nothing else.

> The package is on npm as [`twinny-server`](https://www.npmjs.com/package/twinny-server);
> its version tracks the extension's. From a checkout,
> `node packages/twinny-server/cli.js` after `npm run build` is the same
> program, so every `npx twinny-server …` below can also be run that way.

**Contents**

- [Quickstart](#quickstart) — first run on the GPU machine and in VS Code
- [Choosing models](#choosing-models) — what quickstart looks for, and the admin page
- [Operator runbook](#operator-runbook) — onboarding, offboarding, rotating, restarting, backups, running as a service
- [For developers](#for-developers) — what a teammate needs to know
- [Building and publishing the package](#building-and-publishing-the-package)
- [Configuration](#configuration) — every field, defaults, validation rules
- [What the gateway serves](#what-the-gateway-serves) — routes and error kinds
- [Access keys and the shared token](#access-keys-and-the-shared-token)
- [Team policy](#team-policy) — what connected extensions enforce; a licence feature
- [Recording](#recording) — keeping request content for review and training; a licence feature
- [Plugins](#plugins) — GitHub and GitLab pull requests, reviewed by your own models; a licence feature
- [Running in Docker](#running-in-docker)
- [Plans, seats and the licence](#plans-seats-and-the-licence)
- [Usage records](#usage-records)
- [Backends that are down](#backends-that-are-down)
- [Admin page](#admin-page)
- [Lifecycle and limits](#lifecycle-and-limits)
- [Logging](#logging)
- [Security notes](#security-notes)
- [Exit codes and common errors](#exit-codes-and-common-errors)
- [Troubleshooting](#troubleshooting)
- [Supported runtime](#supported-runtime)

## Quickstart

Everything below runs on the machine with the models unless it says otherwise.

The short version is one command:

```sh
npx twinny-server quickstart
```

It does steps 2 to 4 for you: finds the model server on this machine
(Ollama, LM Studio, llama.cpp, QVAC, Open WebUI, LiteLLM, any
OpenAI-compatible server on its usual port; `--backend [kind=]host[:port]`
names one instead), asks it which models it has and writes
`./twinny.gateway.json` with them (on a terminal you pick a chat, an
autocomplete and an embedding model from the list; `--yes` takes the
recommendations), makes an admin key named after your OS user
(`--admin <name>` to choose; printed once, keep it), and serves. The banner
shows the admin page address; sign in there and check **Providers &
models**. If no server was running, the file has placeholder model names
to change there. To wipe a gateway and start again, stop it and run
`quickstart --fresh` (or `reset --yes --all`; see
[Starting over](#starting-over)).

1. Have a backend running. The starter configuration uses Ollama on its
   default port:

   ```sh
   ollama pull qwen2.5-coder:7b
   ollama pull nomic-embed-text
   ```

2. Write a starter configuration and edit the model names to what you pulled:

   ```sh
   npx twinny-server init          # writes ./twinny.gateway.json
   ```

3. Make an access key for yourself. Each developer gets their own; the key
   is printed once and only its hash is kept.

   ```sh
   npx twinny-server keys create alice
   ```

   (The shared-token route still works: set `TWINNY_GATEWAY_TOKEN` instead.
   See "Access keys" below for the transition.)

4. Start the gateway:

   ```sh
   npx twinny-server serve --config ./twinny.gateway.json
   ```

   It prints where it listens, the protocol version, how many aliases it
   serves and how clients may get in, then logs one line per request:

   ```
   Twinny gateway 4.0.18 listening on http://127.0.0.1:8765
     protocol: twinny/v1 at /twinny/v1
     models:   2 aliases (coder: fim/chat, embed: embeddings)
     limits:   2 active, 120s deadline, 5s grace
     health:   http://127.0.0.1:8765/healthz
     admin:    http://127.0.0.1:8765/admin (sign in with an admin key)
     access:   1 active key
     usage:    /home/you/.twinny/server/usage (kept 30 days)
   ```

5. Connect the extension. In the Twinny sidebar, open **Providers → Add**
   and pick the **Twinny gateway** card (under "Another machine"):

   - **Hostname / port / protocol**: where the gateway listens (for a remote
     machine, the address you exposed in step 6).
   - **API path**: leave empty unless a reverse proxy serves the gateway
     under a prefix.
   - **Gateway token**: paste the key from step 3. It is stored in VS
     Code's secret storage, not with the provider, and is not exported with
     the provider list.
   - **Model**: the list is fetched from the gateway and shows only the
     configured aliases. Pick `coder` for a chat or FIM provider and `embed`
     for an embedding provider.

   Create one provider per job you want (chat, FIM, embedding) and use
   **Test provider** on each. A streamed reply in chat, or a ghost-text
   completion, means inference is flowing through the gateway.

6. To reach the gateway from another machine, bind another interface
   explicitly:

   ```json
   "listen": { "host": "0.0.0.0", "port": 8765 }
   ```

   Binding anything but loopback exposes the gateway to that network. Across
   anything you do not trust, put HTTPS in front of it: a reverse proxy
   (Caddy, nginx, Traefik) forwarding to `127.0.0.1:8765`, or an encrypted
   tunnel (SSH port forwarding, Tailscale, WireGuard). The gateway does not
   manage certificates. With a proxy under a prefix such as
   `https://ai.example.com/twinny`, set the provider's protocol to `https`,
   the port to `443` and the API path to `/twinny`.

## Choosing models

`quickstart` asks every usual local address at once, through the same
adapter the gateway will serve it with, using the extension's own list:
Ollama (11434), LM Studio (1234), llama.cpp (8080), QVAC (11435),
Oobabooga, LiteLLM, Open WebUI, and any OpenAI-compatible server. Whoever
answers with a model list is in; with several, a terminal asks which one
(otherwise the first in that order). `--backend [kind=]host[:port]` skips
the search and asks that one server (`lmstudio=10.0.0.5`,
`llamacpp=gpu-box:8080`, `http://host:8000` for an OpenAI-compatible
server; `--ollama host[:port]` is the Ollama shorthand Docker Compose
uses). The three-second timeout applies per server.

The models are then sorted by name into what each role needs: embedding
models (`nomic-embed-text`, `all-minilm`, `bge`, `mxbai`, …) for
embeddings; code models (`qwen2.5-coder`, `codellama`, `starcoder`,
`codestral`, `deepseek-coder`, …) for autocomplete, base or `:code`
variants first; anything that is not an embedding model for chat, instruct
variants first. On a terminal each role shows the list with a
recommendation on top; otherwise the recommendation is taken. When nothing
answers, placeholders are written and the run says so.

Afterwards, for a second backend, or for a hosted API, use **Providers &
models** on the admin page: add the provider, pick a model from the list it
fetches from the backend, give it an alias and capabilities, and set the
team defaults. Saves apply to new requests without a restart. Nothing
installs software or downloads models; the gateway only lists what the
backend already has.

## Operator runbook

Everything here is done on the machine running the gateway. `--config`
points the `keys` and `usage` commands at the same files the server uses;
pass it whenever your configuration sets `auth.keysFile` or `usage.dir`.

### Files on disk

| What | Where (default) | Contains | Secret? |
| --- | --- | --- | --- |
| Configuration | wherever you put `twinny.gateway.json` | listen address, backends, aliases, limits, the *names* of secret env vars | no |
| Keys | `~/.twinny/server/keys.json` | key ids, names, SHA-256 hashes, created/revoked dates, admin flag | hashes only; still treat as private (mode 600) |
| Usage | `~/.twinny/server/usage/YYYY-MM-DD.jsonl` | one line per inference request: key, alias, outcome, duration, token counts | no content, but it is per-person activity |
| Licence | `~/.twinny/server/license` | the signed licence token, when the team has one | no, but it names your organisation |
| Recordings | `~/.twinny/server/recordings/` | the content of requests, only for routes switched on under `recording` with a licence that allows it | yes: prompts, code and replies |
| Audit log | `~/.twinny/server/audit/YYYY-MM.jsonl` | who changed what, hash-chained | no, but it names people |
| Plugins | `~/.twinny/server/plugins.json` | which bundled plugins are switched on | no |
| Plugin data | `~/.twinny/server/plugins/<id>/` | each plugin's own files; the GitHub and GitLab plugins keep `repos.json` and `reviews.json` there | yes: repository tokens and the GitHub App key (mode 600); reviews quote the code |
| Shared token | the environment variable named by `auth.tokenEnv` | the token itself | yes |
| Backend API keys | the environment variables named by `providers.*.apiKeyEnv` | the keys themselves | yes |

Back up the configuration and `keys.json`. Usage files are yours to keep or
not; retention deletes them by age. Nothing else is written anywhere.

### First start

`twinny-server quickstart` does all of this in one go. By hand:

1. `twinny-server init`, edit the model names, start it.
2. Make yourself an admin key: `twinny-server keys create <you> --admin`.
   Keep it somewhere safe; it opens the admin page and makes other keys.
3. Open `http://<gateway>/admin`, sign in with that key, check the
   Backends panel says "answering".

### Starting over

Stop the gateway, then:

```sh
twinny-server reset --config twinny.gateway.json          # lists what would go
twinny-server reset --config twinny.gateway.json --yes    # removes it
```

That removes the keys file, the licence, the usage records and the
recordings at the paths the configuration names (the defaults under
`~/.twinny/server` without `--config`). Add `--all` to remove the
configuration file too. Every key stops working, so each developer will
need a new one; sign-in requests are only ever in memory and are gone with
the process. `quickstart --fresh` is `reset --yes --all` followed by
`quickstart`, for trying the gateway out from nothing.

On the developers' side nothing is removed: their VS Code still holds the
old key in secret storage and the team connection. They reconnect with
**Providers → Connect to team → Request a key**, which replaces it.

### Onboarding a developer

The short way is an invite link. On the admin page under **People →
Invite**, type Alice's name, tick **admin** if she is an operator, and
**make invite link**. The field next to the name is the address the link
carries: it is filled from the address you opened the page at, so if that
is `localhost` or a tunnel, put the address developers reach the gateway at
there (the page remembers it). Copy the link, or the ready-made message,
and send it to her. Opening it in VS Code (a `vscode://rjmacarthy.twinny/join?…` link)
makes her key under that name, stores it in secret storage, and shows her
the team's models to confirm. Nothing is read out or pasted. The link opens
once and expires after seven days; an unopened invite holds no seat. The
same from a terminal:

```sh
twinny-server invites create alice --url https://ai.example.com
```

`invites list` shows what is open and `invites withdraw <id>` cancels one
that went to the wrong person. On Cursor or VSCodium the link's scheme is
`cursor://` or `vscodium://` instead.

When you are both at a keyboard, sign-in works without a link. Alice opens
the twinny sidebar, **Providers → Connect to team**, enters the gateway URL
and chooses **Request a key**. VS Code shows her a code such as `WXYZ-2345`.
She reads it to you; it appears under **Sign-in requests** on the admin
page with her suggested name and machine. You type the key name, tick
**admin** if she is an operator, and **approve**. Her VS Code collects the
key within a few seconds, stores it in secret storage, and runs the usual
team preview. The code is good for ten minutes; nothing is created until
you approve.

Approve only a code that was read to you by the person. The request shows a
suggested name, but it comes from their machine and proves nothing.

If the name already holds an active key, the page offers **replace existing
key**: the old key is revoked as the new one is made, so a developer who
lost theirs (a reinstall, a Linux machine with no keyring) gets back in
without taking a second seat. You cannot replace the key you are signed in
with.

The long way, when you would rather hand out keys yourself, is the admin
page (Keys → name → **create key**) or:

```sh
twinny-server keys create alice
```

Send the printed `tsk_…` key to Alice over a channel you trust (it is a
password). She pastes it into **Connect to team** or into a **Twinny
gateway** provider. Either way the key is active immediately; no restart.

One key per person. Keys are how usage is attributed, so a shared key
defeats the point.

### Offboarding a developer

On the admin page (**revoke** next to the key, then confirm), or:

```sh
twinny-server keys revoke alice
```

Their next request fails with "This gateway key was revoked on <date>",
within a second, no restart. Their usage history stays in the records
under their name until retention removes it. A revoked name can be reused
for a new key.

### Rotating a key

Revoke the old one, create a new one with the same name, send it over.
Do this for your own admin key from the CLI (the page refuses to revoke the
key you are signed in with, so you cannot lock yourself out by accident).

### Changing the configuration

| Change | Takes effect |
| --- | --- |
| Creating or revoking a key (CLI or page) | immediately, while running |
| Providers and models saved from the admin page | immediately for new requests |
| Direct edits to `twinny.gateway.json` (including limits and listen address) | on restart |
| A new value in the token or API-key environment variables | on restart, in the shell that starts the server |

Restart = Ctrl+C (or SIGTERM), then start again. Active requests get
`limits.shutdownGraceMs` to finish and are then cancelled; VS Code sees a
`cancelled` error and simply retries on the next keystroke or message.

### Retiring the shared token

Once every developer has a key, set `"auth": { "tokenEnv": null }` and
restart. Until then the server prints a note at startup that both are
accepted. Requests made with the shared token are attributed to `shared`.

### Running it as a service

A minimal systemd unit, with the token in an environment file the unit can
read and nobody else can:

```ini
# /etc/systemd/system/twinny-server.service
[Unit]
Description=Twinny inference gateway
After=network.target

[Service]
User=twinny
WorkingDirectory=/home/twinny
EnvironmentFile=/home/twinny/twinny-server.env      # TWINNY_GATEWAY_TOKEN=… (optional once keys exist)
ExecStart=/usr/bin/node /home/twinny/twinny-server/cli.js serve --config /home/twinny/twinny.gateway.json
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

`journalctl -u twinny-server` then shows the request log. Keys and usage
live under that user's `~/.twinny/server/` unless the configuration says
otherwise. Run `twinny-server keys …` as the same user, or pass `--config`
with paths that user can read.

### Choosing the port when it starts

`listen` in the configuration says where the gateway listens. The process
can say otherwise, so one configuration serves several instances behind a
reverse proxy: `serve --port 8801 --host 127.0.0.1`, or the `TWINNY_PORT`
and `TWINNY_HOST` environment variables (the flags win). Neither is written
back to the file.

### A public demo

`serve --demo` opens the gateway to strangers without handing it to them.
The admin page opens with no key, as a visitor who can read everything
except recorded content and change nothing: every write answers 403, and the
visitor cannot run a model. "Try it in VS Code" on the page makes a guest
invite (`POST /twinny/v1/demo/invite`, no credential; five an hour per
address, 25 guests at once). The key it opens into lasts an hour, holds no
seat, and leaves the key file a day after it stops. Admin keys work as usual.

Set `limits.maxOutputTokens`, `limits.perKey` and a small
`limits.maxBodyBytes` on a demo: guests spend your backend's money. Behind a
reverse proxy keep the gateway on loopback; `X-Forwarded-For` is believed
only from a loopback peer.

### Checking it is healthy

- `curl http://127.0.0.1:8765/healthz` → `{"status":"ok"}` means the process
  is up. It says nothing about backends.
- The admin page header, or `GET /twinny/v1/status` with any key, says
  which backends answer right now.
- `twinny-server usage --since 24h` shows whether anyone is getting
  failures, and from which model.

## For developers

You need two things from whoever runs the gateway: its address and your
key (`tsk_…`).

1. In VS Code: Twinny sidebar → **Providers → Add** → the **Twinny
   gateway** card (under "Another machine").
2. Hostname, port and protocol as given; API path empty unless told
   otherwise.
3. Paste your key into **Gateway token**. It is stored in VS Code's secret
   storage, not in settings, and is not exported with your provider list.
4. Pick a model from the list (it is fetched from the gateway). Make one
   provider each for chat, FIM (completions) and embeddings if you use them.
5. **Test provider**. "as <your name>" confirms the gateway knows who you are.

Things worth knowing:

- Your key is yours. Usage is reported per key; lend it and someone else's
  work shows up as yours.
- "This gateway key was revoked": ask the operator for a new one and paste
  it into the provider (edit → Gateway token; leaving it blank keeps the old one).
- "is rate limiting requests": the gateway is busy, or your key hit its own
  limit. It clears by itself within a minute.
- "Could not connect": the gateway is unreachable from your machine. Check
  the address, VPN or tunnel, and that `http://<gateway>/healthz` answers.
- Prompts and code go to the gateway and its backend only. The gateway logs
  and stores request metadata (which model, how long, token counts), never
  content.

## Building and publishing the package

The package lives in `packages/twinny-server/` and is built by the root
build alongside the extension:

```sh
npm run build                 # writes packages/twinny-server/cli.js, syncs its version to the root
cd packages/twinny-server
npm pack --dry-run            # three files: cli.js, package.json, README.md
npm publish                   # when ready; needs npm login
```

The VSIX is unaffected: `.vscodeignore` excludes `packages/**`, and `vsce`
still packages from the repository root. The package version always equals
the extension version, so the two release together.

## Configuration

One JSON file, passed with `--config`. Every field except `providers` and
`models` has a default.

| Field | Meaning | Default |
| --- | --- | --- |
| `listen.host` | Interface to bind. `127.0.0.1` is loopback only. | `127.0.0.1` |
| `listen.port` | TCP port. `0` picks a free port and prints it. | `8765` |
| `auth.tokenEnv` | Environment variable holding the shared access token, or `null` to retire the shared token. | `TWINNY_GATEWAY_TOKEN` |
| `auth.keysFile` | Where named access keys are kept (hashes only). `~/` is expanded. | `~/.twinny/server/keys.json` |
| `auth.licenseFile` | Where the licence token is kept. A missing file means the free plan. | `~/.twinny/server/license` |
| `usage.dir` | Where per-day usage files go. | `~/.twinny/server/usage` |
| `usage.retentionDays` | Usage files older than this are deleted. | `30` |
| `providers.<name>.provider` | Adapter kind: `ollama`, `lmstudio`, `llamacpp`, `oobabooga`, `litellm`, `openwebui`, `openai-compatible`, `deepseek`, `openai`, `anthropic`, `mistral`, `groq`, `openrouter`, `cohere`, `perplexity`, `gemini`, another `twinny-remote` gateway, or `team` (teammates' computers; see [Pooling teammates' computers](#pooling-teammates-computers)). | required |
| `providers.<name>` with `provider: "team"` | Takes no endpoint fields: teammates' extensions dial the gateway. At most one per configuration. | |
| `providers.<name>.apiHostname` / `apiPort` / `apiProtocol` | Where the backend listens. | the adapter's usual address |
| `providers.<name>.apiKeyEnv` | Environment variable holding the backend's API key. | none |
| `providers.<name>.paths.{fim,chat,embeddings}` | Route per job. For chat this is the OpenAI-style base (`/v1`); for FIM and embeddings the full route. | the adapter's usual route |
| `models[].alias` | The public name clients ask for. Letters, digits, `. _ : / -`. Unique, case-insensitively. | required |
| `models[].provider` | A key of `providers`. | required |
| `models[].model` | The backend's own model name. | required |
| `models[].capabilities` | Any of `fim`, `chat`, `embeddings`. Only these are served for the alias. | required |
| `models[].contextWindow` | Advertised to clients; informational. | none |
| `teamDefaults.{chat,fim,embeddings}` | The alias a developer gets for each job on Connect to team. | none |
| `policy.teamOnly` | Only the team gateway: a connected developer may not add or activate providers of any other kind. | `false` |
| `policy.lockDefaults` | Keep the team's default models active for their jobs while connected. | `false` |
| `recording.chat`, `recording.fim`, `recording.embeddings` | Keep the content of these requests. Needs the `recording` licence feature; disclosed to developers. | `false` |
| `recording.retentionDays` | Records older than this are deleted. | `90` |
| `recording.dir` | Where records live. | `~/.twinny/server/recordings` |
| `recording.store` | `auto` (sqlite on Node 22+, else jsonl), `sqlite`, or `jsonl`. | `auto` |
| `limits.maxActiveRequests` | Chat and autocomplete requests running at once. Extra requests are refused with `rate-limited`; nothing queues. Embedding requests are not counted. | `4` |
| `limits.requestDeadlineMs` | How long one inference request may run. On expiry the backend is aborted and the client receives `timeout`. | `120000` |
| `limits.maxBodyBytes` | Largest request body accepted. | `8388608` (8 MiB) |
| `limits.maxOutputTokens` | The most tokens one chat or autocomplete request may generate, whatever the client asks for. | unset (the client decides) |
| `limits.shutdownGraceMs` | How long active requests get to finish after SIGINT/SIGTERM before they are aborted. | `5000` |
| `limits.perKey.maxActiveRequests` | Chat and autocomplete requests one key may have running at once. | none |
| `limits.perKey.requestsPerMinute` | Chat and autocomplete requests one key may start within any 60 seconds. | none |

Rules the loader enforces before the listener opens:

- Unknown fields anywhere are refused, so a typo cannot silently change
  behaviour.
- Aliases must be unique; every alias must reference a configured provider;
  every capability must be one the chosen adapter can run.
- Every alias/capability pair is checked with the same provider validation
  the extension uses for its own providers.
- Secrets are read only from the variables named in `auth.tokenEnv` and
  `apiKeyEnv`. There is no shell expansion and nothing in the file is
  executed. A named variable that is unset stops startup.

A configuration that passes can still name a backend that is down. That is
reported per request as `provider-unavailable`, and the health route keeps
saying `ok`: it means the listener is running, not that every backend is.

Configuration precedence: the file wins for everything it sets; defaults
fill the rest; the environment supplies only the secrets the file names.
There are no other environment variables and no command-line overrides.

One alias maps to one provider and one backend model. There is no load
balancing, no fallback chain and no automatic download.

## What the gateway serves

| Route | Method | Token | Purpose |
| --- | --- | --- | --- |
| `/healthz` | GET | no | `{"status":"ok"}` while the listener is up, `503 {"status":"stopping"}` while draining. Nothing else. |
| `/twinny/v1/models` | GET | yes | The configured aliases, their capabilities, and the backend model behind each (the extension picks its fill-in-the-middle prompt format from that, so an alias can be called anything). |
| `/twinny/v1/team` | GET | yes | The team's default chat, FIM and embedding aliases, plus the model catalogue. No backend addresses or credentials. |
| `/twinny/v1/whoami` | GET | yes | Which key the credential belongs to (`key`, `shared`, `admin`). The provider test in VS Code shows it as "as alice". |
| `/twinny/v1/status` | GET | yes | Asks every backend whether it answers (5 s each) and which aliases that affects. A `team` provider reports `peers`, how many computers are sharing. |
| `/twinny/v1/peers` | GET + `Upgrade: websocket` | personal key | A developer's extension sharing its computer with the team. The shared token is refused. See [Pooling teammates' computers](#pooling-teammates-computers). |
| `/twinny/v1/admin/peers` | GET | admin key | The computers sharing right now: key, machine, models, jobs in flight, served and failed counts. |
| `/twinny/v1/admin/peers/<id>/disconnect` | POST | admin key | Closes that sharing connection (code 4003). The extension reconnects unless its owner switches sharing off. |
| `/admin` | GET | no | The admin page (see below). The page itself signs in with an admin key. |
| `/twinny/v1/admin/usage`, `/twinny/v1/admin/keys` | GET | admin key | The page's data: usage for everyone and the key list. |
| `/twinny/v1/admin/keys` | POST | admin key | `{"name","admin"}` → a new key, returned once. |
| `/twinny/v1/admin/keys/<id>/revoke` | POST | admin key | Revokes a key; not the one making the call. |
| `/twinny/v1/admin/config` | GET / PUT | admin key | Reads or saves providers and models with a revision check. Saves persist to the config file and apply live. |
| `/twinny/v1/admin/license` | GET / PUT / DELETE | admin key | The plan and seats; `{"token"}` installs a licence after verifying it; DELETE removes it. Applies live. |
| `/twinny/v1/admin/recordings` | GET | admin key | A page of recorded requests: `route`, `key`, `since`, `q`, `before`, `limit`. With the store and settings summary. |
| `/twinny/v1/admin/recordings/<id>` | GET | admin key | One record in full. |
| `/twinny/v1/admin/recordings/export` | GET | admin key | JSON lines: `format=training` (default) or `raw`; same filters. |
| `/twinny/v1/signin` | POST | no | Starts a sign-in: `{"name","machine"}` (both optional suggestions) → `{"deviceCode","userCode","expiresAt","interval"}`. Bounded to 5 waiting per client address and 100 in total; ten-minute expiry. |
| `/twinny/v1/signin/poll` | POST | no | `{"deviceCode"}` → `{"status"}`: `pending`, `slow-down` (polled faster than `interval`), `denied`, `expired`, or `approved` with `key` and `name`, returned once. |
| `/twinny/v1/admin/signin` | GET | admin key | Waiting sign-in requests: code, suggested name and machine, timestamps. Never the device code. |
| `/twinny/v1/admin/signin/<code>/approve` | POST | admin key | `{"name","admin","replace"}` mints the key under that name (seat rules apply) and releases it to the poller. A name that already holds an active key is refused unless `replace` is true, which revokes that key in the same step and needs no free seat. |
| `/twinny/v1/admin/signin/<code>/deny` | POST | admin key | Refuses the request; the poller sees `denied`. |
| `/twinny/v1/admin/provider-models` | POST | admin key | Lists models using the supplied provider configuration, including an unsaved draft. |
| `/twinny/v1/fim` | POST | yes | Streams completion chunks as JSON lines. |
| `/twinny/v1/chat` | POST | yes | Streams chat chunks as JSON lines. |
| `/twinny/v1/embeddings` | POST | yes | Returns vectors. |

A request names an alias and a capability and nothing about the backend.
Fields the protocol does not define are refused with `400`, so a client
cannot supply provider URLs, credentials, paths or server settings.

Errors carry the extension's own error kinds, so a failure at the gateway
reads the same in VS Code as a failure at a directly configured provider:
`authentication` (401), `model-unavailable` (404), `unsupported-capability`
(400), `rate-limited` (429), `timeout` (504), `provider-unavailable` (503),
`cancelled` (499), `inference-failure` (502). Once a stream has started, the
failure arrives as its final line instead.

Closing the connection cancels the backend request. Stopping a completion or
chat in VS Code, or the extension's own abort, therefore stops the GPU too.

## Access keys and the shared token

Every protocol route needs `Authorization: Bearer <credential>`. A credential
is either a **named access key** or the **shared token**; the health route
needs neither.

### Named access keys

```sh
twinny-server keys create alice          # prints tsk_…; shown once, only the hash is stored
twinny-server keys list                  # id, name, created, active / revoked
twinny-server keys revoke alice          # by name or id; effective without a restart
```

A key looks like `tsk_<id>_<secret>`. The server finds the record by id and
compares the SHA-256 of the secret in constant time. The keys file is
rewritten atomically with owner-only permissions and reread by a running
server whenever it changes, so a revocation applies to the very next
request. Names are unique among active keys; a revoked name can be reused.

The developer pastes the key into the **Gateway token** field of their
provider. Nothing else about the extension changes. Requests are attributed
to the key's name in the log and the usage records; nothing a client sends
can change that attribution.

Pass `--config <file>` to the `keys` commands when the configuration moves
`auth.keysFile` away from the default, so they edit the file the server reads.

### Moving off the shared token

Existing installations keep working: with `auth.tokenEnv` set and the
variable present, the shared token is accepted alongside keys, and its
requests are attributed to `shared`. To transition:

1. Create a key per developer and hand them out. The server prints
   `access: N active keys, plus the shared token` and a note while both are
   accepted.
2. Once everyone has a key, set `"auth": { "tokenEnv": null }` (or unset the
   variable) and restart. Shared-token requests then fail with
   `authentication`.

With no active keys and no shared token the server refuses to start (exit 3)
and says which of the two to set up.

### Transport

The extension never follows a redirect on a protocol request, so a
misconfigured or hostile proxy cannot bounce a credential to another origin.
Across untrusted networks put HTTPS in front of the gateway; see the
quickstart.

A reverse proxy in front of the gateway must pass WebSocket upgrades on
`/twinny/v1/peers` for sharing to work; see
[Pooling teammates' computers](#pooling-teammates-computers). Everything
else is plain HTTP.

## Team policy

The team route already tells a connecting extension which models to use.
With a licence that carries the `policy` feature it can also carry a
**policy**: rules the extension enforces on the developer's machine.

| Rule | Effect in VS Code |
| --- | --- |
| `teamOnly` | The add-provider gallery shows only the team gateway; adding or activating any other provider is refused with the reason. |
| `lockDefaults` | Chat, autocomplete and embeddings stay on the team's models; switching to another provider is refused with the reason. |

Edit it on the admin page under **Policy**, or in the file:

```json
"policy": { "teamOnly": true, "lockDefaults": true }
```

How it reaches a developer:

- **Consent first.** Connect to team shows the policy before anything is
  applied; connecting is agreeing to it.
- **Re-read at every VS Code start.** A change on the admin page reaches
  everyone at their next start. A gateway that stops sending a policy
  (removed, or the licence lapsed) releases them.
- **Leaving is one click.** The Providers tab shows "Managed by your
  team" with a **Leave team** button that removes the team's entries, their
  key and the policy. The policy is a guard rail for a team that agreed on
  it, not a lock on the developer's machine; what the gateway sees is who
  is connected and what they use.

Without a policy the tab says "Connected to your team" instead, with the
same **Reconnect** and **Leave team** buttons. **Reconnect** re-checks the
team's defaults with the key already on the machine; nobody pastes a key
or asks for a new code unless theirs is gone. The connection survives
VS Code restarts either way: the team's provider entries are saved with
the other providers and the key in VS Code's secret storage. Nobody
needs to sign in again unless they leave, or the key is gone from secret
storage (the tab says so, and VS Code warns at start with the fix). A key
cannot be backed up or read back from the gateway, which keeps only its
hash; a developer who lost one signs in again and the admin approves with
**replace existing key**, which revokes the old one in the same step.

Without the feature the policy is saved but not sent; the admin page says
so next to the section.

### Prompt library and team system prompt

With the `policy` licence feature, `policy.systemPrompt` is put before
every chat's system prompt on connected extensions, and
`policy.templates` (name, optional description, a Handlebars prompt
with `{{code}}`, `{{language}}` and `{{selection}}` filled in) appear in
every developer's template picker beside their own; a shared name wins
over a local file of the same name. Both are shown on the consent card
before connecting and re-read at every VS Code start. Edit them under
**Policy → Prompt library**.

### Quotas

`policy.quotas` caps what a key may use per UTC day, in requests
(`requestsPerDay`) and in tokens the backends reported
(`tokensPerDay`): a `default` for every key and `keys` by name for
exceptions. At `warnAt` (0.8 unless set) a `quota.warning` event goes
out once per key per day (the Slack, Discord and Teams plugins can post
it); at the cap the request is refused with 429 before it reaches a
backend and a `quota.reached` event goes out. Counts are seeded from
today's usage at start, so a restart resets nobody. Quotas need the
`policy` licence feature and are never sent to extensions. `GET
/twinny/v1/admin/quotas` shows every key's standing; the People page
shows it as a bar.

```json
"policy": {
  "quotas": { "default": { "requestsPerDay": 2000, "tokensPerDay": 2000000 }, "keys": { "ci": { "requestsPerDay": 20000 } }, "warnAt": 0.8 }
}
```

### Routing rules

`policy.routing` decides which aliases may serve a workspace. The
extension sends the open workspace's folder name as
`X-Twinny-Workspace`; the first rule whose glob matches applies:

```json
"policy": {
  "routing": [
    { "workspace": "payments-*", "localOnly": true },
    { "workspace": "docs", "aliases": ["cheap"] }
  ]
}
```

`localOnly` refuses any alias served by a hosted provider (OpenAI,
Anthropic, Mistral and the like) for that workspace; `aliases` allows
only those named. A refused request fails with a message that says
which rule. Rules need the `policy` licence feature and stay on the
gateway. Edit them under **Policy → Routing rules**.

## Pooling teammates' computers

A developer who is connected to the team can click **Share this computer
with the team** in the Twinny sidebar. Their extension opens one outbound
WebSocket to the gateway with the key they already have and announces the
models on their local server (Ollama, LM Studio, llama.cpp, whatever they
share). The gateway then treats that machine as a backend: aliases pointed
at a `team` provider are served by whichever connected teammate has the
model, least loaded first. Requests flow requester → gateway → sharer →
gateway → requester, streamed as usual, and usage records say which
machine served each one (`peer=alice@desktop`).

Nothing dials in to the sharer: their extension connects out, so no port,
firewall rule or hole punch is needed. The shared token cannot share
(usage must say who served), and sharing consumes no extra seat.

### Configuring the pool

Add one provider of kind `team` and point aliases at it, on the admin page
(**Providers & models → Add provider → Team members' computers**) or in
the file:

```json
"providers": {
  "local": { "provider": "ollama" },
  "team": { "provider": "team" }
},
"models": [
  { "alias": "coder", "provider": "team", "model": "qwen2.5-coder:7b", "capabilities": ["fim", "chat"] },
  { "alias": "embed", "provider": "team", "model": "nomic-embed-text", "capabilities": ["embeddings"] }
]
```

`models[].model` is the backend model name a sharer must have. There is
no spill-over from a server-backed alias to the pool: an alias is either
on the pool or not, so "where did my code go" has one answer. The team
route tells connected extensions what the pool wants
(`sharing.wanted = ["qwen2.5-coder:7b", "nomic-embed-text"]`), and the
share card says "The team is looking for … · `ollama pull …` to help"
when the developer does not have it.

### What developers see

- **Requesters** are told, before connecting and on the "Managed by your
  team" banner, that requests to those aliases may run on teammates'
  computers. This is a disclosure like recording, sent whenever the pool
  has aliases, licence or not.
- **Sharers** see a card under the team banner: a switch, which local
  server to share, and a status line ("Online · sharing qwen2.5-coder:7b ·
  14 requests served"). Switching on shows one sentence of consent:
  teammates' prompts run on this computer through the chosen server and
  are not stored there. The setting `twinny.teamShareSlots` (default 2)
  is how many requests the computer runs at once. Sharing resumes when
  VS Code restarts, and only one window per machine shares.
- **Admins** see who is sharing what on the admin page, can disconnect a
  computer, and see usage by `key@machine`. Revoking the key cuts the
  connection within 15 s.

### When things go wrong

| Event | What happens |
| --- | --- |
| Sharer closes VS Code or loses network | In-flight jobs end with `provider-unavailable` ("The teammate serving this request went offline"); a job that had produced no chunk is retried once on another peer; the peer disappears from status within 15 s. |
| Sharer's local server is down | The job fails with `provider-unavailable`; the peer is skipped for 30 s so others are preferred; the share card says the server is not answering. |
| No peer has the model | `provider-unavailable`: "No teammate is sharing qwen2.5-coder:7b right now." Every peer busy: `rate-limited`; nothing queues. |
| Requester cancels | The gateway sends `cancel`; the sharer aborts the local request. |
| Gateway restarts | Peers reconnect with backoff (1 s to 30 s); in-flight jobs were failed by the close. |
| Gateway behind a proxy without WebSocket upgrades | The handshake fails; the share card says so and names the route. |
| Admin removes the `team` provider | Peers are closed with 4004 and switch themselves off; the share card hides. |

### Reverse proxies

The sharing connection is a WebSocket on `/twinny/v1/peers`. nginx:

```nginx
location /twinny/v1/peers {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

Caddy passes upgrades by default (`reverse_proxy 127.0.0.1:8765`).

The gateway relays every byte of a pooled request. That is fine at team
scale: chunks are small, prompts are bounded by `limits.maxBodyBytes`, and
the gateway is already in the path for accounting.

## Recording

Off by default, and off without a licence that carries the `recording`
feature. With both, the gateway keeps the content of the requests you
choose: the conversation and reply for chat, the prompt, suffix and
completion for autocomplete, the inputs for embeddings (never the vectors).

```json
"recording": { "chat": true, "fim": true, "embeddings": false, "retentionDays": 90 }
```

Or on the admin page under **Recordings**, which also shows the records:
filter by route, developer, period or text, open one to read the whole
conversation, and export what you see. Embedding records from one
developer to one alias with no gap over two minutes fold into a single
*indexing run* row (a workspace index is hundreds of calls); click it to
see each call. The records and the export stay one per call.

| What developers see | Where |
| --- | --- |
| "The gateway keeps the content of your chat conversations, autocomplete requests." | On Connect to team, before they agree, and on the Managed by your team banner afterwards. Re-read at every VS Code start. |

This is disclosure, not consent per person: the gateway is the team's, and
recording is a team decision. Say so in whatever your team agrees to. A
developer who does not accept it does not connect.

### Storage

`recording.store` chooses: `sqlite` uses Node's built-in `node:sqlite`
(Node 22.5 or newer; one indexed file, `recordings.sqlite`); `jsonl` is one
file per day, which works everywhere. `auto`, the default, picks sqlite
where it exists. The Docker image runs Node 22. Both stores hold the same
record:

```json
{ "id": "…", "at": "…", "key": "alice", "route": "chat", "alias": "coder", "model": "qwen2.5-coder:7b",
  "outcome": "ok", "ms": 812, "usage": { "promptTokens": 120, "completionTokens": 40 },
  "request": { "messages": [ … ], "temperature": 0.2 }, "response": { "content": "…" } }
```

### Export for training

```sh
twinny-server recordings export --route chat --since 30d > chat.jsonl
twinny-server recordings export --route fim --format training > fim.jsonl
twinny-server recordings stats
```

An autocomplete normally ends with the editor stopping the stream once it
has the lines it wants; the record keeps the completion that was shown and
is marked `ok`, ended by the client. A chat the person stopped stays
`cancelled`, since its reply is partial.

The training format is one example per line: chat as
`{"messages": [ …, {"role": "assistant", "content": …}]}`, autocomplete as
`{"prompt", "suffix", "completion"}`, embeddings as `{"input": […]}`. Failed
and cancelled requests are left out. `--format raw` gives the records as
stored. The admin page's Export button produces the same file.

## Running on Kubernetes

`deploy/helm/twinny-server` is a Helm chart: one pod, one volume, the
configuration from `values.yaml` copied onto the volume so the admin page
can edit it, an optional Ingress with TLS, and a ServiceMonitor for the
Prometheus operator scraping `/metrics` with a read-only admin key.

```sh
helm install twinny ./deploy/helm/twinny-server \
  --set config.providers.local.apiHostname=ollama.models.svc.cluster.local \
  --set ingress.enabled=true --set ingress.host=twinny.example.com --set ingress.tls.enabled=true
kubectl exec deploy/twinny-twinny-server -- node /app/cli.js keys create you --admin --config /data/twinny.gateway.json
```

The image is `ghcr.io/twinnydotdev/twinny-server`, built on every `v*`
tag by `.github/workflows/docker.yml`. Keep `replicaCount` at 1: keys,
usage and plugin files live on the one volume.

## Running in Docker

`packages/twinny-server/` has a `Dockerfile` and a `docker-compose.yml`
that runs Ollama and the gateway together. The image is one Node runtime
plus `cli.js`; everything the gateway writes lives under `/data`.

```sh
cd packages/twinny-server
docker compose up -d ollama
docker compose exec ollama ollama pull qwen2.5-coder:7b
docker compose exec ollama ollama pull codellama:7b-code
docker compose exec ollama ollama pull nomic-embed-text
docker compose run --rm twinny-server init /data/twinny.gateway.json --host 0.0.0.0 --ollama ollama
docker compose run --rm twinny-server keys create you --admin --config /data/twinny.gateway.json
docker compose up -d
```

`--host 0.0.0.0` makes the gateway listen inside the container; Compose
publishes it to `127.0.0.1:8765` on the host only, so TLS goes in front as
usual. `--ollama ollama` points the starter at the Compose service. Every
`docker compose run --rm twinny-server …` command (keys, usage, license)
shares the data volume with the running gateway and takes effect live.

Images are published to `ghcr.io/twinnydotdev/twinny-server` by
`.github/workflows/docker.yml` on pushes to `main` and on version tags,
for amd64 and arm64. To build locally: `npm run build` at the root, then
`docker build -t twinny-server packages/twinny-server`.

## Plans, seats and the licence

A **seat** is an active access key. Revoked keys do not count. Every
gateway has a plan:

| Plan | Seats | How |
| --- | --- | --- |
| Free | 5 | Nothing to do. Permanent. |
| Team | as bought | A licence token from Twinny, installed once. See [Teams and licensing](https://twinnydotdev.github.io/twinny-docs/teams/licensing/). |

The gateway never contacts Twinny. A licence is a signed token
(`twl1.…`) whose signature is checked against a public key built into
`twinny-server`; the claims inside it are the organisation name, the seat
count and the dates. Nothing else is gated today, and no usage is
reported anywhere.

### What happens at the limit

- **Creating a key** when every seat is taken is refused, on the CLI and
  on the admin page, with the plan named: "5 active keys and the free plan
  allows 5". Revoke a key or add seats.
- **More keys than seats** can still happen: a licence lapses, or a
  smaller one is installed. The oldest keys keep their seats; the newest
  are refused at every request with "This gateway key has no seat", and
  the banner and admin page list them by name. Revoking any seated key
  frees a seat for the next in line, without a restart. The admin key made
  on day one is therefore never locked out.
- **Expiry** has a grace period of 14 days during which the licensed seat
  count still applies; the banner, the log (`event=license.notice`) and the
  admin page say so from 30 days before. After the grace the free plan
  applies.

### Installing a licence

```sh
twinny-server license                       # the plan, seats in use, expiry
twinny-server license set twl1.…            # install (verified first; a bad token changes nothing)
twinny-server license set --file token.txt
twinny-server license remove
```

Or paste the token on the admin page (**Plan and licence**). Either way it
takes effect within a second, without a restart. Pass `--config` when the
configuration moves the licence file away from the default.

## Usage records

Every inference request (not discovery or health) appends one JSON line to
`<usage.dir>/<YYYY-MM-DD>.jsonl`:

```json
{"ts":"2026-09-14T10:12:03.412Z","key":"alice","route":"fim","alias":"coder","outcome":"ok","status":200,"ms":812,"promptTokens":412,"completionTokens":24}
```

Fields: timestamp, key name, route, alias, outcome (`ok`, `error`,
`cancelled`), error kind when there is one, HTTP status, duration, how many
chunks the client received (streams), how many texts an embeddings request
carried (`inputs`), and the token counts **only when the backend reported them** (Ollama and llama.cpp
report them on the final chunk; OpenAI-style servers in `usage`). Nothing is
estimated, and no prompt, completion, header or backend body is ever written.
Files older than `usage.retentionDays` are deleted at startup and daily.

Embedding calls are grouped when summarised, on the admin page and in
`twinny-server usage`: indexing a workspace is hundreds of small calls in a
row, so a developer's calls to one alias with no gap longer than two
minutes are one *indexing run*, which counts as one request (failed if any
call failed, with the calls' durations added up). The calls and texts are
reported alongside. The records themselves stay one line per call.

```sh
twinny-server usage                       # last 7 days, by key and model
twinny-server usage --since 24h --by key
twinny-server usage --since 2026-09-01 --by model
```

```
Usage since 2026-09-07 10:00 UTC (7d) from /home/you/.twinny/server/usage:
  318 requests: 301 ok, 12 failed, 5 cancelled; 91204 prompt and 6120 output tokens reported on 296

KEY    MODEL  REQUESTS   OK  FAILED  CANCELLED  PROMPT TOK  OUTPUT TOK  AVG MS     INDEX RUNS
alice  coder       210  204       3          3       61230        4011     640              -
alice  embed         2    2       0          0           -           -   41210  2 (388 calls)
bob    coder        96   90       6          0       28974        2109     702              -
```

The report reads the files directly; the server need not be running.

## Costs

Give an alias a price and the Usage page shows what its tokens cost:
in the model's form on **Providers & models** (per million input and
output tokens), with the currency set once on the same page. The
summary then carries a cost per developer, per model and in total for
the period, computed from the token counts the backends reported, so a
local model with no price shows nothing and a hosted one shows the bill.
In the file:

```json
"pricing": { "currency": "USD" },
"models": [{ "alias": "gpt", "provider": "cloud", "model": "gpt-4o-mini", "capabilities": ["chat"], "price": { "input": 0.15, "output": 0.6 } }]
```

## Backends that are down

A backend being unreachable is never a configuration error. At startup the
gateway probes each one after the banner and prints, for example:

```
  backend:  local-ollama answers (12 ms)
  backend:  gpu-2 is not answering (provider-unavailable); its aliases will fail until it is.
```

Requests to an alias on a dead backend fail with `provider-unavailable` and
release their slot at once; other aliases are unaffected. `GET
/twinny/v1/status` runs the same probe on demand, and the admin page shows
it in its header and its Backends table. The health route never changes:
`/healthz` says the listener is up, nothing more.

## Admin page

`http://<gateway>/admin` is a single dark page for whoever runs the gateway.
It is served to anyone but shows nothing until signed in with an **admin
key**:

```sh
twinny-server keys create you --admin
```

The key stays in that browser tab (session storage); nothing is set as a
cookie. The page shows, for the last 24 h, 7 d or 30 d:

- whether every backend answers, and which aliases a down one affects;
- requests, success rate, failures, cancellations and reported token counts;
- requests per day, stacked by key (colours follow the key, the long tail folds into "other");
- usage by key and model, the backends, and every key with its role and status.

Keys can be made and revoked on the page as well as with the CLI: a new
key is shown once with a copy button, and revoking asks for a click of
confirmation. The key you are signed in with cannot be revoked from the
page (use the CLI). A developer key is refused with 403 on the admin
routes, and the shared token is never an admin. Both actions are logged
with the admin's key name and the affected key's name.

### Providers and models

Open **Providers & models** to add, edit or remove backends and public model
aliases. Provider settings include the adapter, hostname, port, protocol,
API-key environment variable and optional custom paths. Model settings include
the backend, public alias, model name, capabilities and optional context window.

The model form fetches the selected provider's available models and offers a
dropdown. **Refresh models** fetches again. If listing fails or the provider
returns no models, enter a model name manually. You can also enter a model
name that is absent from the list. Listing uses the gateway's existing adapter
and backend credentials; it works with provider changes still in the draft.

**Apply to draft** stages a form's changes. **Save changes** validates the whole
draft, atomically writes the configuration and applies it to new requests.
Requests already running finish with their original routing. The gateway does
not need a restart for edits saved here; direct edits to the file still do.
Renaming a provider updates its model references. Remove or reassign a
provider's models before removing the provider. Keep at least one provider
and model in the configuration.

Invalid settings, missing backend key environment variables and conflicting
admin edits leave the file and running routes unchanged. Reload after another
admin saves; if the file changed outside the page, restart the gateway to load
those edits first. The gateway process needs write access to the configuration
directory. The page never accepts or returns backend key values: set them in
the gateway process's environment and enter only the variable name. Adding a
new environment variable to a running service requires restarting that service.
Auth, listener, limits and usage settings cannot be changed through this API.
Saves are logged as `admin.config-updated` with the admin identity and model
count; configuration contents and credentials are not logged.

### Connect developers to the team

1. In **Providers & models → Team defaults**, select aliases for chat,
   autocomplete and embeddings, then **Save changes**. Each selector only
   offers aliases with the matching capability. Leave unused features unset.
2. Give each developer the gateway base URL and their own access key, created
   from **Keys** or `twinny-server keys create <name>`. Use a reachable HTTPS
   address or tunnel when connecting from another machine.
3. Under **People → Invite**, make an invite link per developer and send
   it. Opening it in VS Code makes their key and lands them on the team's
   defaults. Or they open **Providers → Connect to team** themselves, enter
   the URL and a key, and select **Check connection**. Either way Twinny
   verifies the key and reads the team defaults; nothing is sent to the
   models, so connecting is one round trip and never waits on a cold model
   or a rate limit.
4. Review the defaults, explicitly confirm any replacement of active settings,
   then choose **Connect**. Every configured feature becomes active; features
   without a default keep their current settings. Existing personal provider
   entries remain available, and each team provider can be tested from its
   card in the Providers tab.

The key is saved in VS Code secret storage, never in exported provider files.
A preview expires after five minutes. Before applying, Twinny rechecks access,
the advertised defaults and the local active selections. A revoked key or
changed configuration requires a fresh check. Failed persistence restores the
previous selections and credentials where storage remains available.

Reconnecting to the same URL updates the same team entries. Changing the
backend model behind an existing alias applies through the gateway immediately.
Changing the team's selected default aliases affects subsequent connections;
existing developers reconnect to adopt those selections. If the embedding
model changes, rebuild the workspace index in the Embeddings tab.

The JSON equivalent is an optional top-level field:

```json
"teamDefaults": { "chat": "coder", "fim": "coder", "embeddings": "embed" }
```

Values must reference existing aliases with the corresponding capability.
Old configurations with no `teamDefaults` continue to serve their existing
models; the admin must choose defaults before developers can use team setup.

The React source is `src/gateway/ui/`; the build inlines it into the
package's single file, so the page needs no assets and no network beyond
the gateway.

## Lifecycle and limits

- **Capacity.** `maxActiveRequests` counts chat and autocomplete requests
  in flight (discovery and health are not counted). A request over the
  limit is refused at once with `rate-limited` and `Retry-After: 1`. A slot
  is released when the request succeeds, fails, times out, is cancelled by
  the client, or is aborted at shutdown.
- **Embeddings are not capped.** Indexing a workspace is hundreds of small,
  quick requests, so neither `maxActiveRequests` nor the per-key limits
  count them; the deadline still applies, and a backend or teammate that
  is busy still answers `rate-limited`, which the extension waits out and
  retries. The extension indexes one file at a time through a gateway.
- **Per key.** `limits.perKey` applies the same idea to each key on its
  own: `maxActiveRequests` running at once and `requestsPerMinute` started
  in any 60-second window (the shared token counts as one key). A key over
  its limit is refused with `rate-limited` and a message naming which limit;
  other keys are untouched. Refusals are logged with `reason=key`.
- **Deadline.** `requestDeadlineMs` bounds each inference request end to
  end. On expiry the backend call is aborted and the client sees `timeout`.
- **Backpressure.** Chunks are written at the pace the client reads them;
  nothing is buffered whole. Request bodies are capped by `maxBodyBytes`.
- **Shutdown.** On SIGINT or SIGTERM the gateway stops accepting requests
  (health answers `503 stopping`), waits up to `shutdownGraceMs` for active
  requests, aborts whatever remains with `cancelled`, closes every
  connection and exits `0`. If something refuses to die it exits `1` three
  seconds after the grace. Nothing is retried, so no inference is duplicated.

## Logging

One line per event on stderr, fields from a fixed allow-list:

```
2026-09-13T20:10:31.412Z info event=gateway.started host=127.0.0.1 port=8765 protocol=twinny/v1 models=2
2026-09-13T20:10:40.007Z info event=request id=3 key=alice route=fim alias=coder outcome=ok status=200 ms=812 chunks=24
2026-09-13T20:10:41.200Z warn event=auth.rejected route=models
2026-09-13T20:10:55.913Z info event=request id=4 key=bob route=chat alias=coder outcome=error kind=timeout status=200 ms=120004
```

`key=` names the access key (or `shared`). Prompts, completions, chat
messages, embeddings, authorization headers, backend response bodies and
credentials are never logged. Logs stay in the process; there is no
telemetry, conversation storage or analytics.

## Security notes

- **The admin page is reachable wherever the gateway is.** On loopback that
  is only this machine. If you bind `0.0.0.0`, put HTTPS in front (the page
  and every API call carry the key as a bearer header) and consider
  restricting `/admin` to your network at the proxy.
- **Admin keys make keys.** Give `--admin` only to operators. A developer key
  gets 403 on the admin API and sees nothing on the page.
- **Sign-in codes create nothing by themselves.** A code lets an admin
  approve or deny; the key is minted at approval under the name the admin
  types and released only to the holder of the 64-hex device code, once.
  Requests live in memory for ten minutes and are capped per client
  address, so the open sign-in routes cannot fill memory or mint keys.
- **Keys are hashed at rest** (SHA-256) and compared in constant time. The
  file is created with mode 600 and rewritten atomically. A lost key cannot
  be recovered; revoke it and make a new one.
- **The page keeps the admin key in that tab's session storage**, never in a
  cookie, so a link cannot act on your behalf. Sign out clears it.
- **Requests cannot reach past the gateway.** A client names an alias and a
  capability; backend addresses, paths and credentials come only from the
  configuration file.
- **Nothing leaves the machine.** No telemetry, no external requests except
  to the configured backends.
- **Content is kept only when you switch recording on**, which needs a
  licence with the feature and is disclosed to every developer who
  connects. Without it, usage records hold metadata only.

## Exit codes and common errors

| Exit | Meaning | Typical message |
| --- | --- | --- |
| `0` | Stopped cleanly after a signal. | `event=gateway.stopped` |
| `1` | Unexpected failure, or shutdown had to be forced. | |
| `2` | Bad arguments or an invalid configuration. | `models[1].alias "coder" is already used by models[0].` |
| `3` | No way in (no keys and no shared token), or a named environment variable is not set. | `No way in: set the TWINNY_GATEWAY_TOKEN environment variable …, or create a named key with \`twinny-server keys create <name>\`.` |
| `4` | A provider kind the gateway cannot serve. | `providers.x.provider "twinny-p2p" is not a provider kind this gateway can serve.` |
| `5` | The port is taken or the host cannot be bound. | `Port 8765 on 127.0.0.1 is already in use.` |

In VS Code:

- **"refused the request: This gateway key was revoked on …"**, "… is not
  known to the gateway", "… no longer accepts a shared token": the gateway
  says exactly why. Edit the provider and paste a current key.
- **"is rate limiting requests"**: either the gateway's `maxActiveRequests`
  or your key's `perKey` limit; the message names which.
- **"Could not connect"**: the gateway is not reachable at that hostname,
  port and protocol. Check `/healthz` from the same machine as VS Code.
- **"does not have the model"**: the alias is not in the gateway's
  configuration. The model dropdown on the provider lists what it serves.
- **"cannot do this"**: the alias is configured without that capability.
- **"is rate limiting requests"**: `maxActiveRequests` is reached.
- **"This gateway key has no seat"**: the gateway has more active keys
  than its plan allows. The operator revokes keys or adds seats; nothing
  to do on your side.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `twinny-server keys create` succeeds but VS Code says the key is "not known to the gateway" | The command wrote to a different keys file than the server reads. | Pass the same `--config` to `keys` commands as to `serve`, or check `auth.keysFile`. |
| The admin page says "The admin page was not bundled into this build" | You ran the tsc output instead of the package bundle. | `npm run build`, then use `packages/twinny-server/cli.js`. |
| Sign-in on `/admin` says "is not an admin key" | The key was made without `--admin`. | Create one with `--admin` (CLI), or tick "admin" on the page while signed in as an admin. |
| "1 of N backends down" in the header, aliases failing with `provider-unavailable` | The backend process (Ollama, LM Studio…) is not running or not at the configured address/port. | Start it; the gateway needs no restart. `GET /twinny/v1/status` shows the detail. |
| `model 'x' not found` from the backend | The alias maps to a model the backend has not pulled. | Pull it, or change `models[].model` and restart. |
| Exit 5, "already in use" | Another process (often an older gateway) holds the port. | Stop it, or change `listen.port`. `lsof -i :8765` finds it. |
| Exit 3, "No way in" | No shared token in the environment and no keys yet. | `twinny-server keys create <you> --admin`, or export the token. |
| Requests refused with `rate-limited` for one person only | That key hit `limits.perKey`. | Wait a minute, or raise the limit and restart. Refusals are logged with `reason=key`. |
| The share card says "did not accept the sharing connection (HTTP 400)" | A reverse proxy in front of the gateway does not pass WebSocket upgrades. | Enable upgrades for `/twinny/v1/peers` at the proxy; see [Reverse proxies](#reverse-proxies). |
| "No teammate is sharing …" although someone is | Their local server does not have that exact model name, or their VS Code is closed. | The admin page's People tab shows who is online and which models; `ollama pull <model>` on the sharer's machine. |
| Usage report is empty | Wrong `--config` (different `usage.dir`), or the period is too short. | Pass `--config`, try `--since 30d`. |
| VS Code shows "cancelled" after a restart of the gateway | Requests in flight were aborted at shutdown. | Nothing to do; the next request goes through. |
| Most `route=fim` lines say `outcome=cancelled status=499` after a few ms | VS Code cancelled the completion request: the next keystroke arrived, or IntelliSense opened and VS Code re-asked with the suggest widget open (twinny declines that re-ask mid-word). The gateway is the first place this became visible; direct providers behave the same. | Normal while typing. Completions arrive when you pause outside a word (after a space, bracket or new line). `status=200 chunks=N` with `cancelled` means the client had enough and stopped reading, also normal. Set the Twinny log to Debug (`Developer: Set Log Level…`) to see the client side. |

## Supported runtime

Node 18 or newer. The published `cli.js` is one file with no dependencies,
so it runs from any directory: no checkout, no `node_modules`, no VS Code,
no Docker. To run it as a service, wrap the `serve` command in systemd or
the equivalent; that packaging is not part of this repository.

Out of scope for this gateway: P2P discovery, GPU sharing, scheduling and
failover; accounts, organisations, SSO and RBAC; usage quotas,
billing and chat storage; model installation; container or service
packaging.

## Audit log

Every change made through the admin API or CLI-equivalent routes is
written to `audit/YYYY-MM.jsonl` under the data directory: keys made and
revoked, invites made, opened and withdrawn, sign-ins approved,
configuration saves, licence changes, plugins switched on or off, and
every write to a plugin's routes (method and path, never the body).
Each line carries the SHA-256 of the line before it, so an edited or
removed line breaks the chain, and **Team → Audit log** on the admin
page says whether the chain is intact and where it breaks. Filter by
period, actor and kind; **export** downloads the whole log as JSON
lines. Nothing secret is written: names, actions, targets, a few short
details and the caller's address.

Routes: `GET /twinny/v1/admin/audit?since=30d&actor=&action=key.&limit=`
returns entries newest first with the verification; `GET
/twinny/v1/admin/audit/export` returns every line.

### Read-only admins

`twinny-server keys create auditor --admin --read-only` (or the
*read-only* box next to *admin* on People) makes a key that opens the
admin page and every admin route with `GET`, and is refused with 403 on
anything that changes state, plugins included. For the person who needs
to see usage, people and the audit log without being able to act.

## Metrics

`GET /metrics` with an admin key (read-only will do) answers in the
Prometheus text format: requests by route, alias and outcome; a latency
histogram; tokens and chunks; requests in flight; each backend's last
check (`twinny_backend_up`); refused authentications; quota refusals;
active keys and seats; plugin events. Point a scrape job at it with a
bearer token:

```yaml
scrape_configs:
  - job_name: twinny
    metrics_path: /metrics
    authorization:
      credentials: tsk_…      # a read-only admin key
    static_configs:
      - targets: ["gateway.example.com:8765"]
```

## Plugins

Plugins are features the server ships with but that are not the gateway:
switched off until an admin turns them on, each with its own files under
the data directory, its own admin routes and its own page. **Plugins →
Store** on the admin page lists what this build carries; **switch on**
starts a plugin at once and adds it to the side navigation, **switch off**
stops it. The choice is kept in `plugins.json`, so it survives a restart.

Plugins are a licence feature (`plugins`, on every Team and Enterprise
licence). Without it the store still lists them but nothing can be
switched on, and plugins that were on stop until a licence is installed;
their switch is kept, so a renewed licence brings them straight back.
The 14-day grace after expiry applies as it does to policy and recording.

The API behind the page, admin keys only:

| Route | Does |
| --- | --- |
| `GET /twinny/v1/admin/plugins` | what is bundled and what is on |
| `POST /twinny/v1/admin/plugins/<id>/enable` | switch on |
| `POST /twinny/v1/admin/plugins/<id>/disable` | switch off |
| `… /twinny/v1/admin/plugins/<id>/api/<route>` | the plugin's own routes, answered by the plugin |

### GitHub and GitLab

Both plugins do the same thing for their host: watch repositories and
show their open pull requests (merge requests on GitLab) with the state
of checks, mergeability and review, and open one with its description and
diffs. They sync every five minutes and on **sync now**; nothing is
written back to the host unless a review is posted (see below).

**Watching a repository.** Give it as `owner/name` (GitLab: the full
`group/project` path) and an access token that can read it:

- GitHub: a fine-grained token with read access to *Pull requests*,
  *Contents*, *Checks* and *Commit statuses*, or a classic token with the
  `repo` scope.
- GitLab: a project, group or personal access token with the `read_api`
  scope.

The token is checked against the host before the repository is kept, so a
wrong one is refused with the host's reason. Tokens live in the plugin's
`repos.json`, readable by the server's user only, and are never shown
again: the page says only that a repository reads with a token.

**A GitHub App instead of tokens.** For a team, create a GitHub App once
(the organisation's *Developer settings → GitHub Apps*) with read
permission on *Pull requests*, *Contents*, *Checks* and *Commit statuses*,
install it on the repositories, generate a private key and paste the App
ID and the key on the plugin's page. The server checks the key by
signing a request to GitHub before keeping it. From then on any
repository the App is installed on can be watched with no token of its
own, and **pick from the App** lists them. The server mints installation
tokens itself (an hour each, renewed as needed); the private key never
leaves the server. Removing the App stops the repositories that read
through it until it is set up again.

**Self-hosted.** Set the host URL on the page for GitHub Enterprise
Server or a self-managed GitLab; the public hosts are the default.

**Reviews by your own models.** A pull's page has **review now**: the
gateway sends the description and diffs to one of its chat aliases (the
*review model* on the plugin page; the first chat alias unless chosen)
and keeps what came back on the server, per pull and commit, in the
plugin's `reviews.json`. The review shows on the pull's page with the
model, the time and who asked; a pull that has moved on marks it as
being for an earlier commit. Posting it to the host is a separate, explicit step (or auto-post).

Ticking **auto-review** on a repository reviews its new and updated
pulls in the background: one at a time, newest first, never drafts, and
only while no developer request is in flight, so completions and chats
are never slowed down. A review that has to wait is retried every
minute. Reviews run through the normal routing and are recorded in
usage under `plugin:github` or `plugin:gitlab`, so the Usage page shows
what they cost. The prompt carries at most 24k characters of description
and diff (larger patches are named but left out) and asks for at most
1,500 tokens back, to suit local models with small contexts.

**Posting a review to the host.** A finished review has **post to
GitHub** (or GitLab, Gitea, Bitbucket) with a choice of how the host
should record it: a comment, a change request or an approval. GitHub and
Gitea take all three as a review; GitLab posts a note and, for an
approval, approves; Bitbucket posts a comment and, when asked, approves
or requests changes. The review is posted with a footer naming the model
and the commit, and the page shows when and where it went. Ticking
**auto-post** on a repository posts every finished review as a comment
without anyone pressing the button, which with **auto-review** makes a
fully automatic first pass on every pull. A `review.posted` event goes
out for the notifiers.

**Issue triage.** On GitHub, GitLab and Gitea the plugin also lists a
repository's open issues. **Triage** sends one to the review model with
the project's labels and the other open issues' titles and gets back
suggested labels, a duplicate if it sees one, a priority and a first
reply, kept on the server. **Post reply** and **apply labels** put them
on the host, with the reply editable first; a footer names the model.
Ticking **auto-triage** on a repository triages new issues in the
background while the models are idle, but replies and labels always
wait for a person. An `issue.triaged` event goes out, marked as a
warning when the priority is high, so a channel can hear about the
serious ones.

**Reasoning models.** A model that thinks before answering (Qwen 3 and
the like) is asked not to (`think: false`, which Ollama honours); a model
that thinks anyway gets a 4,000-token budget, inline `<think>` blocks are
removed from the answer, and a review that came back as thinking only
fails with that reason rather than "answered nothing".

**Plugin routes** under `/twinny/v1/admin/plugins/<github|gitlab>/api/`:

| Route | Does |
| --- | --- |
| `GET /` | repositories with their open pulls and sync state |
| `POST /repos` `{ fullName, token? }` | watch a repository; the token may be left out when the GitHub App is set up |
| `DELETE /repos/<id>` | stop watching |
| `POST /repos/<id>/sync`, `POST /sync` | sync one, or all |
| `GET /repos/<id>/pulls/<number>` | one pull with its description, files and latest review |
| `POST /repos/<id>/pulls/<number>/review` | review it now with the review model; answers when the review is done |
| `POST /repos/<id>/pulls/<number>/review/post` `{ as? }` | post the finished review to the host as `comment` (default), `request-changes` or `approve` |
| `PUT /repos/<id>` `{ autoReview?, autoPost?, autoTriage? }` | review new and updated pulls in the background; post every finished review as a comment; triage new issues in the background |
| `GET /repos/<id>/issues/<number>` | the issue with its body and latest triage |
| `POST /repos/<id>/issues/<number>/triage` | triage it now with the review model |
| `POST /repos/<id>/issues/<number>/triage/post` `{ reply?, replyText?, labels?, labelNames? }` | post the reply and/or apply the labels |
| `PUT /settings` `{ baseUrl?, reviewAlias? }` | the host URL; the chat alias reviews use |
| `PUT /app` `{ appId, privateKey }`, `DELETE /app`, `GET /app/repositories` | the GitHub App (GitHub only) |

### Gitea, Forgejo and Bitbucket

Two more forges on the same pull-request core, with the same page,
reviews and events as GitHub and GitLab:

- **Gitea / Forgejo** (also Codeberg, which runs Forgejo): set your
  instance's URL on the plugin page, then watch repositories with an
  access token (*Settings → Applications*, read access to repositories).
  Statuses of the head commit and reviews are read from their own
  routes; a pull's changes from its `.diff`.
- **Bitbucket** (Bitbucket Cloud): watch `workspace/repo-slug` with an
  app password given as `user:app-password` (sent as Basic auth) or an
  API token. Build statuses come from the head commit, approvals from
  the pull's participants.

### Discord and Microsoft Teams

The same notifier as Slack with the message shape each host takes:
Discord gets an embed (title linked, colour by level) through a channel
webhook (*Server settings → Integrations → Webhooks*); Teams gets an
Adaptive Card, which both a Workflows "post to a channel when a webhook
request is received" flow and the older Incoming Webhook connector
accept. Routes, event catalogue, delivery log and secrecy of the URLs are
as for Slack, under `/twinny/v1/admin/plugins/<discord|teams>/api/`.

### SSO sign-in (OIDC)

The OIDC plugin lets developers sign in with the company's identity
provider (Okta, Entra ID, Google Workspace, Keycloak, Authentik, any
OpenID Connect provider) instead of an invite or a code. Register a
confidential web application at the provider with the redirect URI
`https://<gateway>/twinny/v1/plugins/oidc/callback` and the `openid`,
`email` and `profile` scopes, then paste the issuer URL, client id and
secret on the plugin's page. **Test provider** reads the discovery
document and the signing keys.

Developers open `https://<gateway>/twinny/v1/plugins/oidc/start` (the
page shows the link to copy). The gateway sends them to the provider
with PKCE, a state and a nonce; on the way back it exchanges the code,
verifies the RS256 id_token against the provider's published keys
(issuer, audience, expiry, nonce), checks the email's domain against
the allowed list, and mints a key for the email through a one-time
invite that opens VS Code. The invite replaces any key of the same
name, so signing in again refreshes the key and revokes the old one.
Emails in *admin emails* get admin keys. Every sign-in is written to
the audit log and raised as a `signin.sso` event.

Only RS256 tokens are accepted. `nameClaim` picks the claim that names
the key (`email` unless the provider has none; `preferred_username` or
`upn`). Set *public URL* when the gateway sits behind a proxy that does
not send `X-Forwarded-Proto`. Provider secrets live in the plugin's
`settings.json`, owner-readable, and never come back from any route.

### Shared context

The Shared context plugin keeps one index of the team's repositories on
the gateway, built with an embeddings alias the gateway serves, so every
connected developer's chat can draw on the whole codebase and not only
the clone on their laptop. Add a repository by clone URL (https with a
token for private ones, ssh with the server's key, or a path on the
server); it is cloned shallow under the plugin's directory, chunked by
lines, embedded in batches, and re-indexed on the interval (60 minutes
unless set) while no developer request is running, embedding only the
files whose content changed. **Try a search** on the page shows what a
chat would pull in.

Connected extensions ask `POST /twinny/v1/plugins/context/search`
`{ query, k? }` with their gateway key and merge the hits into the
"relevant code" their chat already gathers from the local workspace, so
nothing changes for the developer except better answers. The route needs
a key; the admin page's search uses the admin route instead. Search is
cosine similarity over every chunk plus a bonus for query words present
in the chunk, capped at 24k characters so it fits a prompt. Embedding
runs are recorded in usage under `plugin:context`.

### Backups

The Backups plugin makes a nightly copy of what the gateway would miss:
the configuration file, keys, licence, invites, `plugins.json` and every
plugin's files, and the usage records; recordings too when asked (they
can be large and hold code). The copy goes to a directory on the server
or to any S3-compatible bucket (AWS, Cloudflare R2, MinIO, Backblaze,
Wasabi, Hetzner…), signed by the server itself with no extra packages.
Set the destination, the time (server local), how many archives to
keep, and optionally a passphrase on the plugin's page; **test
destination** writes and deletes a probe, **back up now** does one at
once.

An archive is a gzipped tar with a manifest (sizes and SHA-256 hashes,
checked on restore), readable by `tar` when not encrypted. With a
passphrase it is AES-256-GCM encrypted (`.tar.gz.enc`); keep the
passphrase somewhere other than the server, since the settings file that
holds it is inside the backup. After a successful run, archives beyond
the kept count are deleted, oldest first.

Restoring is a CLI job done with the gateway stopped:

```sh
twinny-server backup list --config twinny.gateway.json
twinny-server backup restore twinny-backup-20260920-030000.tar.gz.enc --config twinny.gateway.json
twinny-server backup restore twinny-backup-20260920-030000.tar.gz.enc --config twinny.gateway.json --yes
```

Without `--yes` it only prints what would be written where. The archive
is a file path, or a name at the configured destination. On another
machine the passphrase comes from `TWINNY_BACKUP_PASSPHRASE` (or the
variable named by `--passphrase-env`). Files not in the backup are left
as they are. `twinny-server backup now` makes a copy from cron or a
shell as the schedule would.

| Route under `/twinny/v1/admin/plugins/backups/api/` | Does |
| --- | --- |
| `GET /` | settings without secrets, the last and next run, the archives at the destination |
| `PUT /settings` | destination (`path` or `s3`), time, `keep`, `includeRecordings`, `schedule`, `passphrase` |
| `POST /check` | writes and deletes a probe at the destination |
| `POST /run` | back up now |
| `GET /archives`, `DELETE /archives/<name>` | list and delete archives |

### Slack

The Slack plugin posts what the other plugins report, and what the
gateway sees, to Slack incoming webhooks; Mattermost and Rocket.Chat
take the same message shape. Add a webhook per channel (Slack: *Apps →
Incoming Webhooks*, add to a channel, copy the URL) and pick what it
gets:

| Event | When |
| --- | --- |
| Review finished, Review asks for changes, Review failed | a model reviewed a pull (the verdict is read from the review's Verdict section) |
| Pull opened | a new pull appeared on a watched repository at a sync |
| Checks failed | a watched pull's checks went from passing or pending to failing |
| Backup made, Backup failed | the Backups plugin ran |
| Backend down, Backend back | a configured backend stopped answering, or answers again (polled every minute) |

**Test** sends a hello to the channel at once. The last hundred
deliveries and their outcomes are shown on the page; a channel that
refuses a message is recorded there, never retried, and never stops the
others. Webhook URLs let anyone post to the channel, so they are kept in
the plugin's `webhooks.json` (owner-readable) and never returned by any
route: the page shows only the host they point at.

Under the hood every plugin shares one event bus (`PluginContext.events`);
a new plugin can emit its own events and any listener sees them.

| Route under `/twinny/v1/admin/plugins/slack/api/` | Does |
| --- | --- |
| `GET /` | webhooks (no URLs), the event catalogue, recent deliveries, watched backends |
| `POST /webhooks` `{ name, url, events? }` | add a channel; every event unless `events` narrows it |
| `PUT /webhooks/<id>` `{ name?, url?, events? }` | change it; a blank URL keeps the old one |
| `DELETE /webhooks/<id>` | remove it |
| `POST /webhooks/<id>/test` | send a hello now |
