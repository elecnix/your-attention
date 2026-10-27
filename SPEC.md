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
| `html` | The agent's own HTML and scripts. The page shows it in a frame with `sandbox="allow-scripts allow-forms"`, only after the owner turns on `allowHtml` in the settings. A script in the frame sends the answer with `yourAttention.answer(values, comment)`. |
| `attachments` | Up to 10 files, each `{src, name, alt}`. `src` is an https URL or a base64 `data:` URL of at most 8 MB. |
| `template` | `{name, version, vars}`: the inbox fills the body from a saved template, replacing each `{{name}}` with the JSON string of its value. |
| `status` | A state label the agent sets, such as `waiting on CI`. |
| `expiresAt` | When the card stops waiting, in epoch milliseconds. The alarm closes it as `expired`. |
| `rating` | How much the card matters to the agent, from 1 to 5. Priority rules can read it. |
| `screen` | The terminal screen of a blocked agent. |
| `priority` | The id of a priority level: `now`, `soon` (the default) or `later` unless the levels changed. |
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

## Secret cards

A card with `kind: "secret"` asks for one value. It carries `secret: {name, publicKey}`, where `name` is a variable name and `publicKey` is an RSA-OAEP public key as a JWK. The agent keeps the private key in memory.

To seal the value, the page encrypts it with a new AES-256-GCM key, then wraps that key with the public key. The answer contains `values.sealed`:

```json
{ "alg": "RSA-OAEP-256+A256GCM", "key": "<wrapped AES key, base64>", "iv": "<base64>", "data": "<ciphertext, base64>" }
```

The inbox refuses any other value on a secret card, so plain text never reaches storage. An answer without `values.sealed` declines the request. A page on plain HTTP from another machine cannot seal, because browsers give Web Crypto to secure origins only.

## Editing cards

`POST /v1/cards/<id>/patch {edits: [{old, new}], field}` edits one field, `text` by default or `body` when the card has one. Each `old` must occur exactly once, or the inbox refuses the whole patch with 409. A revision, by patch or by posting the same id, adds 1 to `version` and keeps the version before it in `history`, up to 20 versions.

`POST /v1/cards/<id>/status {status}` sets the agent's state label. An empty label clears it.

Text in `text` links to another card with `[[card-id]]`. The page shows the title of the linked card and previews its text on hover. Below the card you have open, it lists the cards that link to it.

## Attachments

The inbox keeps the bytes of each `data:` attachment in its blob store, R2 in the Cloudflare build and files on disk on a laptop, and the card keeps a reference `{id, name, type, size, alt}`. It stores the bytes before it commits the card, so the card changes in one step. Replacing a card's attachments deletes the old files.

`GET /v1/attachments/<id>` serves the bytes to owner and extension tokens, and to the client that posted the card. Images, PDF, Markdown, text, CSV and JSON come back inline, and every other type as a download with `content-type: application/octet-stream`. Each response has `x-content-type-options: nosniff` and a Content Security Policy that blocks scripts.

## Templates

`POST /v1/templates {name, source, feedback}` saves a new version of a template. `GET /v1/templates` lists them, and `GET /v1/templates/<name>` returns one with every version and the feedback each version answers.

## Priority levels

`GET /v1/priorities` returns the levels as `{id, label, definition, rule}`. Agents and the owner replace them with `PUT /v1/priorities`. A `rule` is an expression over the card: `kind`, `agent`, `priority`, `status`, `rating`, `tags`, `blocked`, `answered`, `waitMinutes` and `harness`. The grammar has comparisons, `&&`, `||`, `!`, arithmetic and `in`, and `src/core/expr.ts` parses it without `eval`. A card shows the first level whose rule matches it. Without a match, it shows the level that the agent gave. `GET /v1/state` returns that level per card in `priorities`.

## Card guidance

`GET /v1/guidance` returns `{text, version}`. `POST /v1/guidance {text}` proposes new guidance: the inbox posts a system card that lists the agents it knows, all picked. An owner client approves with `choice: approve` and the `agents` to reach. The inbox then stores the new version and sends `guidance` events to the picked agents that are online. The `hello` event carries the current guidance version, so an agent that was offline can fetch it.

## Settings

`GET /v1/settings` returns `{allowHtml}`. Only the owner changes it, with `PUT /v1/settings`.

## Card states

| State | Meaning |
| -- | -- |
| `open` | Waits for the person. |
| `answered` | The inbox stored the answer. Its agent is offline or has not received it yet. |
| `delivered` | The harness received the answer. |
| `read` | The model has the answer in its context: the agent called `POST /v1/cards/<id>/ack`. |
| `closed` | The agent retracted the card or answered it itself, with `POST /v1/cards/<id>/close {kind, outcome}`, or the card expired. |
| `in-triage` | An extension on the `card.created` hook is checking the card. |
| `held` | A fail-closed hook timed out, or an extension stopped the card. The card shows which extension and why. |
| `orphaned` | The card is open, and its agent has been offline for more than an hour. Another session can claim it. |

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
| Agents connect to the inbox from wherever they run | Outbound links to a remote server, and bridges. |
| Many links to one inbox act as a mesh | Message dedupe across links. |
| A hosted inbox works without an account | The hosted service. |
