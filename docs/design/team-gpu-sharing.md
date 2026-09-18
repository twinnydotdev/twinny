# Design: sharing a GPU with the team through the gateway

Status: implemented 2026-09-15 (milestones 1–3 and the gateway side of 4).
Code: `src/protocol/{websocket,peer,job}.ts`, `src/gateway/{peers,team-pool}.ts`,
`src/extension/team/{sharer,share,bridge}.ts`, `src/webview/providers/share.tsx`;
tests in `src/test/suite/{websocket,peer-protocol,gateway-peers,team-share}.test.ts`.
Operator docs: `docs/gateway.md` → "Pooling teammates' computers".

## The feature in one paragraph

A developer who is connected to a team clicks **Share this computer with the
team** in the Twinny sidebar. Their extension opens one outbound connection to
the team gateway, using the key they already have, and announces the models on
their local server. The gateway now treats that machine as a backend: aliases
the admin has pointed at **Team members' computers** are served by whichever
connected teammate has the model, least-loaded first. Requests from other
developers flow gateway → sharer's machine → gateway → requester, streamed as
today. When the sharer closes VS Code the gateway stops routing to them; when
they open it again, sharing resumes. The admin sees who is sharing what on the
admin page, and usage records say which machine served each request.

The requester side does not change at all: they use the team provider and an
alias. Only the gateway learns a new kind of backend, and the sharer's
extension learns to serve.

## Why this shape

### The sharer dials out; the gateway never dials in

The existing P2P feature (`src/p2p`, `src/node`) has the GPU machine *listen*
on the DHT and the consumer dial it. That is right for two personal devices and
wrong for a team, for three reasons:

- **Networking.** Listening needs an open UDP port, a firewall rule, and a
  hole punch through the sharer's NAT. That was the single hardest support
  problem of the P2P work (ufw, `HOLEPUNCH_ABORTED`). A team already has one
  thing everyone can reach: the gateway. An outbound HTTPS connection from the
  sharer needs nothing.
- **Packaging.** `twinny-server` is one dependency-free file that runs on
  `node:22-alpine`. hyperdht brings `sodium-native` and `udx-native` (native
  addons) into the gateway. Not worth it.
- **Identity.** The sharer already has a named key. Reusing it gives
  authentication, seat accounting, revocation, and per-key usage for free.

So the connection is a **WebSocket from the extension to the gateway**,
authenticated with the developer's key. The gateway relays every byte of a
pooled request. That is fine: chunks are small text, prompts are at most the
gateway's body limit, and the gateway is already in the path for accounting and
recording. A direct sharer↔requester hop over hyperdht is a later optimisation
(see "Later").

### WebSocket rather than two HTTP streams

The peer→gateway direction must stream (chunks as they are generated). Over
plain HTTP that is a streamed *request body*, which nginx buffers in full by
default (`proxy_request_buffering on`), silently turning streaming into
"everything arrives at the end". A WebSocket either works or fails loudly at
the handshake, and every reverse-proxy guide covers it. The docs already say
"put HTTPS in front"; the runbook gains a two-line nginx/Caddy note.

Node has no WebSocket server built in and the server bundle must stay
dependency-free, so `src/protocol/websocket.ts` implements the small subset of
RFC 6455 both sides need: the handshake accept key, text and control frames,
client-side masking, fragmentation, 64-bit lengths, ping/pong/close, a 16 MiB
frame cap, no extensions. The extension uses the same module over
`http.request` + `Upgrade`, so nothing depends on the VS Code Node version
(the engine floor is 1.93, whose Node has no global `WebSocket`). About 300
lines, pure, tested against the RFC vectors.

### The sharer runs the inference layer, not a raw HTTP relay

The P2P node forwards raw Ollama routes. For the team the sharer instead
receives the same `FimRequest` / `ChatRequest` / `EmbeddingRequest` the gateway
hands its own adapters, runs it through `resolveInferenceProvider()` against
its local backend, and streams back `FimChunk` / `ChatChunk` with usage. This:

- makes any local backend shareable (Ollama, LM Studio, llama.cpp, QVAC), not
  just Ollama;
- reuses `parseRequest` (allow-listed fields) on both ends, the error kinds,
  usage token counts, and cancellation semantics;
- lets the gateway treat a peer as an ordinary `InferenceClient` behind the
  route table, so nothing above `routes.ts` knows the difference.

The core of `handler.ts#runInference` (parse → route → stream → done/error)
is factored into a transport-neutral `runInferenceJob()` in
`src/protocol/job.ts`; the HTTP handler and the peer's job runner both call it.

### One pool, explicit aliases

The gateway gets one new provider kind, `team` ("Team members' computers"):

```json
"providers": { "team": { "provider": "team" } },
"models": [
  { "alias": "coder", "provider": "team", "model": "qwen2.5-coder:7b", "capabilities": ["fim", "chat"] },
  { "alias": "embed", "provider": "team", "model": "nomic-embed-text", "capabilities": ["embeddings"] }
]
```

An alias on the pool is served by any connected peer whose announced model list
contains that backend model name. Per-peer providers (`alice`, `bob`) were
rejected: peers come and go and the admin cannot maintain aliases per person.
Automatic spill-over from a server-backed alias to peers with the same model
was rejected for v1: it makes "where did my code go" ambiguous, and the
disclosure below depends on the admin having chosen it. It is the first
follow-up (see "Later"), as an explicit per-alias field.

Two things fall out of the pool being explicit:

- The team route tells connected extensions what the pool wants
  (`sharing.wanted = ["qwen2.5-coder:7b", "nomic-embed-text"]`), so the share
  card can say "The team is looking for … · you have qwen2.5-coder:7b".
- Requesters are told, in the consent screen and the team banner, that
  requests to those aliases run on teammates' computers. This is a disclosure
  like `recording`, sent regardless of licence.

## Protocol between sharer and gateway

`src/protocol/peer.ts`, pure, NDJSON text frames over the WebSocket, version 1.
Route: `GET /twinny/v1/peers` with `Upgrade: websocket` and the usual bearer
key. The shared token is refused (peers must be named keys, or usage cannot say
who served). Draining gateways refuse with 503.

Sharer → gateway:

| frame | fields | notes |
| --- | --- | --- |
| `hello` | `protocol`, `name` (machine), `backend: { kind }`, `models: [{ id, name }]`, `slots` | Must be the first frame within 5 s or the socket is closed. `slots` is how many jobs the sharer will run at once (setting, default 2). |
| `models` | `models` | Sent whenever the local list changes (polled every 60 s). |
| `chunk` | `id`, `chunk` (a `FimChunk` or `ChatChunk`) | |
| `done` | `id`, `usage?` | Embeddings send `done` with `response` instead of chunks. |
| `error` | `id`, `error: { kind, message }` | Same shape as the HTTP protocol's error body. |
| `pong` | | |

Gateway → sharer:

| frame | fields | notes |
| --- | --- | --- |
| `welcome` | `protocol`, `wanted: string[]`, `slots` | `slots` is min(peer's, gateway cap of 8). |
| `job` | `id`, `capability`, `request` | `request` already passed `parseRequest`; `model` is the backend model name. |
| `cancel` | `id` | Requester went away, deadline hit, or gateway stopping. |
| `ping` | | Every 15 s; no `pong` within 15 s closes the socket and fails its jobs. |

Close codes: 1001 gateway stopping, 4001 key revoked, 4002 protocol error,
4003 admin disconnected, 4004 sharing not configured (no `team` provider).

## Gateway

- `src/protocol/websocket.ts` (shared): codec + `acceptUpgrade(req, socket, head)`
  + `dialWebSocket(url, headers)`.
- `src/protocol/peer.ts` (shared): frame types and parsers, both directions.
- `src/protocol/job.ts` (shared): `runInferenceJob()` factored out of the handler.
- `src/gateway/peers.ts`: `PeerRegistry`. A `Peer` is `{ id, key (name),
  machine, backend kind, models, slots, inflight, connectedAt, served, failed,
  degradedUntil }`. `attach(socket, principal)`, `pick(model, capability)`
  (peers offering the model with a free slot, not degraded, least in-flight,
  ties broken round-robin), `run(peer, job) → AsyncIterable<chunk>`,
  `disconnect(id, code)`, `snapshot()`. A peer whose job fails with
  `provider-unavailable` (its local server is down) is degraded for 30 s.
  Emits `change` for the admin page.
- `src/gateway/team-pool.ts`: `TeamPoolAdapter` registered as kind `team` at
  serve start, before the config is parsed (so `knownProviders` includes it;
  `configuration.ts` must compute its `kinds` list lazily rather than at import).
  `capabilities()` = all three. `models()` = union of connected peers' wanted
  models, throwing `provider-unavailable` when no peer is online so `/status`
  reads "not answering". `fim/chat/embeddings` = pick → run; if the peer is
  lost before the first chunk, pick another once. The chosen peer is reported
  back through the route target so the request log and usage record carry
  `peer=alice@desktop`.
- `server.ts`: `server.on("upgrade")` → path check → `authenticate()` (same
  function, shared token refused) → `registry.attach`. `stop()` closes peers
  after in-flight jobs finish. Every 15 s the registry re-verifies each peer's
  key (`keys.refresh()` + `verify`) and closes revoked ones with 4001.
- `config.ts`: kind `team` takes no endpoint fields (`apiHostname`, `apiPort`,
  `apiProtocol`, `apiKeyEnv`, `paths` refused); at most one such provider;
  `configuration.save` skips endpoint validation for it. Team aliases are
  validated like any other. `UNSERVABLE_PROVIDERS` unchanged.
- `routes.ts`: `checkBackends` reports the pool as `{ provider: "team", ok,
  ms: 0, peers: n }`.
- Protocol types: `RemoteBackendStatus.peers?`, `RemoteTeam.sharing?: {
  wanted: string[] }`, `TeamPolicy.peers?: string[]` (aliases that run on
  teammates' computers; disclosure, sent whenever the pool has aliases).
- `usage.ts`: `UsageRecord.peer?: string`; `summarizeUsage` gains a by-peer
  view for the admin page.
- Admin API: `GET /twinny/v1/admin/peers` (snapshot), `POST
  /twinny/v1/admin/peers/<id>/disconnect`. Admin page: People tab gets a
  Sharing column (online · models · served today · disconnect); Overview shows
  "N computers sharing"; the Team members' computers provider card shows how
  many are online, and the model picker for a team alias lists the union of
  peer models via the existing `provider-models` route.
- Recording keeps working unchanged: capture happens in `runInferenceJob` on
  the gateway side of the relay.

## Extension (the sharer)

- `src/extension/team/share.ts`: `TeamShare`. State: `off → connecting →
  online → reconnecting`. Persisted per machine in globalState
  (`twinny.teamShare`: `{ enabled, backend: { kind, host, port, protocol } }`);
  resumes at activation after `TeamConnection`. Reconnects with backoff 1 s →
  30 s plus jitter; stops and forgets when the developer leaves the team, or
  the gateway closes with 4001/4004. Gets the team URL and key from
  `TeamConnection` (a new `session()` that exposes `{ url, token }` from the
  connected team's provider ids and credentials).
- Single window per machine: the lock-file logic in `P2pHost` moves to
  `src/extension/utils/window-lock.ts` and both use it. Other windows show
  "sharing from another window".
- Serving: on `job`, `runInferenceJob()` with a route function that (1) refuses
  any model not in the last announced list (`model-unavailable`), (2) builds a
  `TwinnyProvider` for the share backend + model + capability with the pure
  part of `providerForRoute` moved to `src/common/backend-route.ts`, (3)
  resolves it through the inference registry. Per-job `AbortController`,
  cancelled by `cancel`, socket close, or a 120 s deadline. Slots from
  `twinny.teamShare.slots` (default 2). Nothing about a job is logged beyond
  model, capability, outcome and timing.
- Model list: `listProviderModels()` on the share backend at start and every
  60 s; `models` frame on change. Capabilities are not inferred locally; the
  alias decides.
- Which backend to share: the picker offers the servers `discoverLocalServers()`
  finds (default: the configured Ollama), the same list first-run setup uses.
- Messaging: `twinny.get-team-share`, `twinny.start-team-share`,
  `twinny.stop-team-share`, `twinny.set-team-share-backend`; event
  `twinny.team-share-changed` carrying `TeamShareStatus { enabled, state,
  runningElsewhere, backend?, models, wanted, served, error }`.
- Webview: a **Share this computer** card in the Providers tab under the
  "Managed by your team" banner, shown only when the team route carries
  `sharing`. Toggle, backend picker, status line ("Online · sharing
  qwen2.5-coder:7b · 14 requests served"), and when none of the wanted models
  are local: "The team is looking for qwen2.5-coder:7b. `ollama pull
  qwen2.5-coder:7b` to help." First switch-on shows one sentence of consent:
  teammates' prompts will run on this computer through the chosen server and
  are not stored here.
- Consent and banner for requesters: `describePolicy` / `policyLines` gain the
  line "Requests to coder and embed may run on teammates' computers."
- Team policy `teamOnly` does not block sharing: the share backend is not a
  provider entry.

## Trust and safety

- Requesters' prompts (their code) reach a teammate's machine. Disclosed to
  requesters before connecting and on the banner; the admin opts the team in
  by configuring the pool. Content is never logged on either side; recording
  stays gateway-only and licensed.
- A sharer can only ever call the one local server they chose. Jobs are
  re-validated with `parseRequest` on arrival; unknown fields are refused;
  the model must be one they announced; body size and frame size are capped.
  No file, command, or URL reaches the sharer from a job.
- A sharer returns text like any backend; a team member modifying their
  extension to return junk is within the trust a team already extends by
  sharing a gateway key. The admin can disconnect them and revoke the key;
  revocation cuts the connection within 15 s.
- Sharing uses the developer's own key and consumes no extra seat. The shared
  token cannot share.
- The gateway refuses jobs beyond a peer's slots and its own
  `maxActiveRequests`, as today (`rate-limited`, nothing queues).

## Failure behaviour

| event | what happens |
| --- | --- |
| Sharer closes VS Code / loses network | Socket closes; in-flight jobs end with `provider-unavailable` ("The teammate serving this request went offline"); a job that had produced no chunk is retried once on another peer; the peer disappears from status within 15 s at worst. |
| Sharer's local server is down | The job fails with `provider-unavailable`; the peer is degraded for 30 s so others are preferred; the share card shows "Ollama is not answering". |
| No peer has the model | `provider-unavailable`: "No teammate is sharing qwen2.5-coder:7b right now." Same kind the client already handles for a down backend. |
| Requester cancels | The gateway sends `cancel`; the sharer aborts the local request, as the P2P gateway does today. |
| Gateway restarts | Peers reconnect with backoff; in-flight jobs were already failed by the close. |
| Gateway behind a proxy without WebSocket upgrades | Handshake fails; the share card says "The gateway did not accept the sharing connection (HTTP 400). If a reverse proxy sits in front, enable WebSocket upgrades for /twinny/v1/peers." Runbook note for nginx and Caddy. |
| Two windows on one machine | Lock file; one shares, the other shows "sharing from another window" and takes over if the first closes. |
| Same key on two machines | Two peers, shown as `alice@desktop` and `alice@laptop`. |
| Admin removes the team provider | Peers are closed with 4004; the share card hides. |

## Tests

- `websocket.test.ts`: RFC handshake vector, frame encode/decode across the
  126/127 length boundaries, masking, fragmentation, control frames inside a
  fragmented message, oversize rejection, close handshake.
- `peer-protocol.test.ts`: parsers reject malformed and oversize frames.
- `gateway-peers.test.ts` (in the extension host, like `gateway.test.ts`): a
  real gateway with a `team` alias plus a fake peer built from the shared codec
  and the fake backend in `support/backend.ts`. Covers: alias served through a
  peer; least-loaded choice across two peers; peer lost mid-stream → error
  frame; retry before first chunk; cancel reaches the peer; slots and gateway
  capacity refusals; unannounced model refused; revoked key closed with 4001;
  shared token refused at upgrade; `/status` and `/team` shapes; usage record
  carries `peer`; draining closes peers after jobs finish.
- `team-share.test.ts`: `TeamShare` against an in-process gateway: connect,
  hello/welcome, serve a job through the fake backend, cancel, reconnect with
  backoff after the gateway restarts, stop on leave, window lock.
- `remote-protocol.test.ts` keeps passing after the `runInferenceJob` refactor.
- Live check: local gateway with a `team` alias, one VS Code window sharing
  `codellama:7b-code` from local Ollama, a second window (separate
  `--user-data-dir`) connected as a different key getting completions; kill the
  sharer mid-request and watch the requester's error; admin page shows both.

## Milestones

1. **Transport and protocol.** `websocket.ts`, `peer.ts`, `job.ts` refactor,
   unit tests. No behaviour change yet.
2. **Gateway pool.** `peers.ts`, `team-pool.ts`, upgrade route, config kind,
   status/team route additions, usage `peer`, `gateway-peers.test.ts`. Testable
   with a scripted peer before the extension exists.
3. **Sharer.** `TeamShare`, window lock extraction, messaging, share card,
   consent lines, `team-share.test.ts`, live check, docs for developers.
4. **Admin and polish.** Peers on the admin page, disconnect, provider card,
   usage by peer, runbook section "Pooling teammates' GPUs", proxy notes.

Roughly 2,300 lines including tests. Milestones 1 and 2 are pure Node and can
be verified end to end without VS Code.

## Later

- **Spill-over.** `models[].spillover: "team"`: when the primary provider
  answers `provider-unavailable` or `rate-limited` before the first chunk, try
  the pool. Explicit per alias, so the disclosure stays accurate.
- **Direct hop.** The gateway brokers a hyperdht pairing between requester and
  sharer (one-time secret over the team route) and the requester's existing
  P2P client talks to the sharer directly, keeping the gateway out of the data
  path. Costs usage accounting and recording for those requests; only worth it
  for large prompts or many developers.
- **Licence gating.** One check against `entitlements.features` if pooling
  should become a paid feature; recommended free for now since seats already
  cap team size and this is the feature that makes the gateway worth running.
- **Restrict who may share** (`policy.sharing`), per-peer statistics, a
  `twinny-server peers` command reading a status file.

## Side finding

A team FIM provider is created with `fimTemplate: automatic` and `modelName`
set to the alias, and `resolveFimFormat` infers the format from that name.
An alias called `coder` therefore gets the default FIM format regardless of the
backend model. Naming aliases after the model family (`qwen-coder`,
`codellama`) fixes it today; a `fimFormat` field on `models[]` sent with the
team route would fix it properly. Unrelated to pooling but worth doing.
