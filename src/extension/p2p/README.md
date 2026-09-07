# Peer to peer

An optional, self contained peer to peer connection manager built on
[hyperswarm](https://github.com/holepunchto/hyperswarm). Nothing in twinny
uses it by default — it is here so that peer to peer features can be built
without every one of them re-inventing discovery, framing and teardown.

## What it does

- Joins a topic and finds other peers who joined the same one.
- Tracks connected peers.
- Sends and receives newline delimited JSON messages.
- Cleans up after itself.

That is the whole of it. There is no inference protocol, no directory server
and no config file. Whatever `key` values your messages use, and what they
mean, is up to the feature built on top.

## Usage

```ts
import { P2P_EVENT_NAME, P2pConnectionManager } from "./p2p"

const p2p = new P2pConnectionManager()

p2p.on(P2P_EVENT_NAME.peerJoin, () => console.log("someone arrived"))
p2p.on(P2P_EVENT_NAME.message, (message, peer) => {
  if (message.key === "ping") p2p.send(peer, { key: "pong" })
})

// Everyone who derives the same topic meets in the same place.
await p2p.join(P2pConnectionManager.topicFromName("twinny-example-room"))

p2p.broadcast({ key: "ping" })

// When you are finished.
await p2p.destroy()
```

## Topics

A topic is 32 bytes. Build one whichever way suits:

| Method | Use it for |
| --- | --- |
| `P2pConnectionManager.topicFromName(name)` | A stable room derived from a known string. |
| `P2pConnectionManager.createTopic()` | A fresh random room you then share. |
| `P2pConnectionManager.topicFromHex(hex)` | A room someone shared with you. |

Share a topic with `topic.toString("hex")`.

## Notes

- `join()` resolves once the topic is announced, not once a peer connects.
  Wait for `peer-join` if you need someone on the other end.
- Pass `{ server: false }` to `join()` to look for peers without announcing
  yourself, or `{ client: false }` to only announce.
- Anyone who knows the topic can connect to it. Treat a topic as a secret if
  the thing behind it is private, and authenticate peers yourself if it
  matters who they are.
