# Protocol specification, version 1

This file specifies the messages, card states and delivery rules that every inbox and client follows. The TypeScript types in `src/core/types.ts` mirror it, and the integration tests in `test/integration/` are the conformance suite. A build in another language passes the suite when it serves the same routes.

## Transport and encoding

Messages are JSON over HTTP. Agents and pages receive events as server-sent events. Each stream sends a `beat` event every 2 seconds, so a client can tell a quiet inbox from a dead one.

`GET /v1/info` returns `{"name":"your-attention","protocol":1,"pair":"/v1/pair"}`.

## Clients and tokens

Each client sends `Authorization: Bearer <token>`. A token has one of two roles:

- `owner` reads every card and answers them. The built-in page and other front-ends use it.
- `agent` posts cards and receives the answers to them. It can also search past answers.

The inbox stores a SHA-256 hash of each token, never the token. The page signs in with `POST /v1/login {token}`, which sets an `HttpOnly`, `SameSite=Strict` cookie. A write that uses the cookie must also send the `x-your-attention: 1` header, which a cross-site form can't set.

On a laptop, the server writes `owner-token` and `agent-token` to its home directory with mode 0600, so processes of the same user connect without pairing.

## Pairing

1. The client sends `POST /v1/pair {name, role}` and gets `{id, code}`, where the code has six digits.
2. The inbox posts a system card that shows the name, the role and the code.
3. The person checks that both screens show the same code, then picks `approve` or `deny` in the `choice` field.
4. The client polls `GET /v1/pair/<id>`. It gets `{status:"approved", token}` once, then `{status:"approved"}` after that.

At most 5 requests can wait at a time, and a request that waits 10 minutes expires as denied.

## Cards

An agent posts `POST /v1/cards` with these fields. Only `agent` and `title` are required.

| Field | Meaning |
| -- | -- |
| `id` | 1 to 80 characters: letters, digits, dots, colons, dashes or the `_` character. Posting the same id again revises the card and adds 1 to its `version`. |
| `agent` | The session that receives the answer, such as `claude:<session id>` or `pi:<session id>`. |
| `kind` | `ask` (the default), `blocked` for a harness that waits on a prompt, or `system` for cards the inbox posts. |
| `title`, `text`, `recommendation` | The question, its context, and what the agent would do. |
| `options`, `multiple` | Answer options as `{id, label, description}`. The person picks with the `choice` field. |
| `questions` | Claude Code `AskUserQuestion` questions. Field `q0` answers the first one. |
| `body` | OpenUI Lang source for a card that brings its own widgets. |
| `screen` | The terminal screen of a blocked agent. |
| `priority` | `now`, `soon` (the default) or `later`. |
| `origin` | Where the session runs: `harness`, `session`, `name`, `host`, `cwd`, `herdrPane`. |
| `tags` | String properties for grouping. |
| `follows` | The card this one follows up on. The inbox sets `followedBy` on that card. |
| `deliver` | `stream` (the default) or `none` for a card that only shows state. |

Only the token that posted a card can change it or acknowledge its answer. The inbox never sends that token id to clients.

## Answers

An owner client sends the answer with `POST /v1/cards/<id>/answer {values, comment, delivery, version}`. Every field is optional, so an empty answer is valid. `delivery` is one of:

- `default`: steer the current turn, or start a new turn when the agent is idle.
- `steer` or `followUp`: the matching delivery in the harness.
- `force`: set by `POST /v1/cards/<id>/force` for an answer the model has not read.

A new answer replaces the old one and keeps it in `previous`.

## Card states

| State | Meaning |
| -- | -- |
| `open` | Waits for the person. |
| `answered` | The inbox stored the answer. Its agent is offline or has not received it yet. |
| `delivered` | The harness received the answer. |
| `read` | The model has the answer in its context: the agent called `POST /v1/cards/<id>/ack`. |
| `closed` | The agent retracted the card or answered it itself, with `POST /v1/cards/<id>/close {kind, outcome}`. |

An answer saved after a close moves the card out of `closed` and goes to the agent. A close with `ifUnanswered: true` fails with 409 when the person already answered.

## Delivery

An agent opens `GET /v1/stream?agent=<id>`, and the inbox reports the agent online until the last such stream closes. The inbox sends each undelivered answer for that agent and that token as an `answer` event:

```json
{ "type": "answer", "id": "5f2a9c01d3e4", "card": { "id": "c1", "title": "Use SQLite?" }, "answer": { "values": { "choice": "o1" }, "comment": "yes" } }
```

The event above is trimmed to the fields an agent reads. The `id` is a receipt: the Claude Code channel watches the session transcript for it before it sends the acknowledgment.

Answers for an offline agent wait. `GET /v1/dead-letters` lists them, and `POST /v1/cards/<id>/claim {agent}` hands one to a successor session.

## Pages

`GET /v1/state` returns every card, answer, presence record and card state. `GET /v1/events` sends `change {card}`, `presence {agent, online}`, and `code` when the page source changed. A page refetches the state on each `change`.

## Search

`GET /v1/search?q=<words>` matches each word as a prefix, over card text and answer comments. The laptop build uses SQLite FTS5.

## Discovery

On a LAN the inbox advertises `_cardinbox._tcp` over mDNS, with the TXT record `v=1`, `id=<inbox id>`, `pair=/v1/pair`. `your-attention serve --no-mdns` turns the advertisement off.

## Principles not built yet

The table lists what version 1 still lacks, by principle. The pull request that builds a missing part deletes its row.

| Principle | What is missing |
| -- | -- |
| One documented message model, with pluggable encodings | WebSocket and long-poll transports. Version 1 has server-sent events only. |
| Platform details sit behind small adapter interfaces | The Cloudflare build, with Durable Object storage, hibernatable WebSockets and alarms. |
| Presence comes from connections, and it survives hibernation | Socket attachments, planned for the Cloudflare version. |
| Triage checks cards before you see them | The triage extension and its hook point. |
| Extensions attach at named hook points, in process or out | Hook points and their failure policies. |
| Agents keep card templates and revise them from your feedback | Template storage and versions. |
| Agents edit a card with small patches | Patch edits. Version 1 replaces the whole card. |
| Card guidance is shared, and you approve each broadcast | Guidance storage and broadcast cards. |
| Cards show a priority and come one at a time | Editable priority levels and rules written as expressions. |
| Cards group by any property agents provide | Grouping in the page. Cards carry `tags` already. |
| Each card has one clear state | States that agents add, such as in triage, expired and orphaned. |
| Cards link to other cards in their text | Hypertext links with previews. Version 1 links follow-ups only. |
| Each card body is free-form widgets that fit its question | The sandboxed frame for scripts and raw HTML. |
| Agents connect to the inbox from wherever they run | Outbound links to a remote server, and bridges. |
| Many links to one inbox act as a mesh | Message dedupe across links. |
| Cards can embed hosted documents, edited live | Document embeds. |
| A hosted inbox works without an account | The hosted service. |
