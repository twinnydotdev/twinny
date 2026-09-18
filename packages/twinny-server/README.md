# twinny-server

Serve the models on one machine to the [Twinny](https://github.com/twinnydotdev/twinny)
VS Code extension on another. One process, one config file, one shared token.

```
VS Code + Twinny  →  twinny-server  →  Ollama / LM Studio / llama.cpp / any OpenAI-compatible server
```

Needs Node 18 or newer. No other dependencies.

Free for up to 5 developers (active keys). Larger teams install a licence
token; see [Teams and licensing](https://twinnydotdev.github.io/twinny-docs/teams/licensing/).
The server never contacts Twinny.

## Quick start

On the machine with the models:

```sh
npx twinny-server quickstart
```

That looks for a model server on this machine (Ollama, LM Studio,
llama.cpp, QVAC, Open WebUI, LiteLLM, any OpenAI-compatible server; or the
one you name with `--backend`), asks it which models it has, and writes
`./twinny.gateway.json` with them (you pick a chat, an autocomplete and an
embedding model from the list; `--yes` takes the recommendations), makes an
admin key for you (printed once; keep it), and starts serving. The banner
shows where it listens (`127.0.0.1:8765` by default), how many model
aliases it serves, how many keys are active, whether each backend answers,
and the admin page address. Open `http://127.0.0.1:8765/admin`, sign in
with the key, and check **Providers & models**: the backend should say
answering and the team defaults should name real models. If no server was
running, the file has placeholder names to change there. The admin page
shows usage by developer and model, backend status, keys and sign-in
requests.

The same, step by step:

```sh
npx twinny-server init
# edit twinny.gateway.json: set each alias's "model" to one you have pulled
npx twinny-server keys create you --admin   # shown once
npx twinny-server keys create alice         # one key per developer
npx twinny-server serve --config twinny.gateway.json
```

To throw everything away and start again (stop the gateway first):

```sh
npx twinny-server quickstart --fresh        # or: twinny-server reset --yes --all
```

In VS Code: Twinny → Providers → **Connect to team**. A developer enters
the address and either pastes their key or chooses **Request a key**: they
read you a short code, you approve it on the admin page, and their key
arrives in VS Code by itself.

To reach the server from another machine, set `"listen": { "host": "0.0.0.0" }`
and put HTTPS or a tunnel (SSH, Tailscale, WireGuard, a reverse proxy) in
front of it. Anything but loopback is exposed to that network.

## Commands

| Command | What it does |
| --- | --- |
| `twinny-server quickstart [--yes] [--fresh] [--admin <name>] [--backend [kind=]host[:port]]` | Finds the model server (or asks the named one) for its models and writes the configuration if missing, makes an admin key if there is none, serves. `--yes` skips the questions; `--fresh` wipes keys, licence, usage, recordings and the configuration first. |
| `twinny-server init [file] [--backend [kind=]host[:port]]` | Writes a starter configuration for one server (`lmstudio=10.0.0.5`, `llamacpp=gpu-box:8080`, `http://host:8000`; Ollama here by default). Never overwrites. |
| `twinny-server reset --yes [--all]` | Removes keys, licence, usage and recordings; `--all` also the configuration file. Without `--yes` it only lists them. |
| `twinny-server serve --config <file>` | Runs the gateway until SIGINT/SIGTERM. |
| `twinny-server keys create <name>` | Makes an access key for a developer. Printed once; only its hash is stored. |
| `twinny-server keys list` / `revoke <name>` | Shows keys; stops one, effective without a restart. |
| `twinny-server usage [--since 7d] [--by key]` | Requests, failures and reported token counts by key and model. |
| `twinny-server keys create <name> --admin` | A key that can also open the admin page at `http://<gateway>/admin`. |
| `twinny-server license [set <token>\|remove]` | The plan and seats. Free: up to 5 active keys. A licence from Twinny raises that; install it here or on the admin page. |
| `twinny-server --version` | Prints the version. Track the extension's version. |

Exit codes from `serve`: `2` invalid config or arguments, `3` a named
environment variable is unset, `4` unsupported provider kind, `5` port in use.

## Docker

```sh
docker compose up -d ollama
docker compose exec ollama ollama pull qwen2.5-coder:7b
docker compose exec ollama ollama pull codellama:7b-code
docker compose exec ollama ollama pull nomic-embed-text
docker compose run --rm twinny-server init /data/twinny.gateway.json --host 0.0.0.0 --ollama ollama
docker compose run --rm twinny-server keys create you --admin --config /data/twinny.gateway.json
docker compose up -d
```

`docker-compose.yml` runs Ollama and the gateway together; the image is
`ghcr.io/twinnydotdev/twinny-server`. Keys, usage and the licence live in
the `twinny-data` volume, and every `docker compose run --rm twinny-server …`
command shares it with the running gateway.

## Backends

The gateway serves any provider kind the extension has an adapter for:
Ollama, LM Studio, llama.cpp, [QVAC](https://docs.qvac.tether.io/cli/http-server/),
Oobabooga, LiteLLM, Open WebUI, any OpenAI-compatible server, and the hosted
APIs (OpenAI, Anthropic, Mistral, Groq, OpenRouter, Cohere, Gemini, …) with
the key read from an environment variable. Quickstart finds the local ones
on their usual ports; for anything else, or a second backend, open
**Providers & models** on the admin page: add the provider, pick a model
from the list it fetches, give it an alias and capabilities, and set the
team defaults. Saves apply to new requests without a restart. Nothing
installs software or downloads models. Use **Test provider** in Twinny, or
**Connect to team**, to check generation end to end.

## Reach it from other machines

The gateway listens on `127.0.0.1` and speaks plain HTTP. Inside a VPN or a
tailnet that is enough: the extension accepts `http://` addresses. Anything
reachable beyond that wants HTTPS in front, and the gateway does not manage
certificates.

**Caddy** (automatic HTTPS; the gateway stays on loopback, only Caddy is exposed):

```
ai.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

```sh
caddy run          # with that Caddyfile in the working directory
```

**Tailscale** (no ports open to the internet):

```sh
tailscale up
tailscale serve 8765        # https://<machine-name>.<tailnet>.ts.net → the gateway
```

Developers use that address, or `http://<machine-name>:8765` inside the
tailnet with `"listen": { "host": "0.0.0.0" }` in the configuration.

## Day to day

- **New developer:** on `/admin` → **People → Invite**, type their name and
  send the link; opening it in VS Code connects them. From a terminal:
  `twinny-server invites create alice --url https://ai.example.com`.
  Keys by hand still work: `twinny-server keys create alice`.
- **Leaving developer:** `twinny-server keys revoke alice` (or the page).
  Effective within a second, no restart.
- **First admin:** `twinny-server keys create you --admin`, then open
  `/admin` and sign in.
- **Providers and models:** open **Providers & models** on `/admin`. Add or
  edit a provider, choose a model from its fetched list, then **Apply to draft**
  and **Save changes**. Saves persist and apply to new requests immediately.
  Manual model entry is available when listing is unavailable. Remove or
  reassign a provider's models before deleting it.
- **Other config changes** (limits, address, auth), or direct file edits:
  edit the file and restart. Keys never need a restart.
- **Files:** keys in `~/.twinny/server/keys.json` (hashes only), usage in
  `~/.twinny/server/usage/`, one file per day, deleted after 30 days.
  Back up the config and `keys.json`.

## Configuration

### Connect a team

In `/admin` → **Providers & models → Team defaults**, select the chat,
autocomplete and embedding aliases, then save. Then invite each developer from
**People → Invite**: the link opens VS Code, makes their key, and shows the
team's models; one click on **Connect** and they are in. Without a link they
open Twinny → **Providers → Connect to team** with the gateway URL and a key,
or **Request a key** and read you a short code. Features without a default keep
their current settings, existing personal providers are retained, and keys live
in VS Code secret storage. Reconnecting updates the same team entries.

Defaults are stored as `teamDefaults`, for example
`{"chat":"coder","fim":"coder","embeddings":"embed"}`. Changing an alias's
backend takes effect live; developers reconnect to adopt a different default
alias. Shared tokens cannot be used for team onboarding.

### File format

One JSON file. `providers` names backends (any provider kind the extension
supports: `ollama`, `lmstudio`, `llamacpp`, `openai-compatible`, `openai`,
`anthropic`, …). `models` maps public aliases onto one provider and one
backend model each, with the capabilities it may serve (`fim`, `chat`,
`embeddings`). `limits` bound concurrent requests, request duration, body
size and shutdown grace. Secrets are only ever read from the environment
variables named in `auth.tokenEnv` and `providers.*.apiKeyEnv`.

The full reference, the request log format, and the authentication and
lifecycle details are in
[docs/gateway.md](https://github.com/twinnydotdev/twinny/blob/main/docs/gateway.md).

## Security

- Named access keys (hashes stored, shown once, revocable live), or a shared
  bearer token from the environment during the transition. Never built in.
- Requests name an alias and a capability; they cannot supply URLs,
  credentials or paths.
- Redirects are never followed by the extension, so the token stays with the
  configured origin.
- Logs and usage records contain request metadata only: never prompts,
  completions, headers or backend bodies. Opt-in recording stores request content
  separately. Inference requests go to the backends you configure; there is no
  telemetry or licence check sent to Twinny.

## License

MIT
