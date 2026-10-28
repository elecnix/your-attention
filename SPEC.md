# Protocol specification, version 1

This file specifies the messages, card states and delivery rules that every inbox and client follows. The TypeScript types in `src/core/types.ts` mirror it, and the integration tests in `test/integration/` are the conformance suite. A build in another language passes the suite when it serves the same routes.

## Transport and encoding

Messages are JSON over HTTP. Agents receive events in whichever of three ways their environment allows:

- `GET /v1/stream?agent=<id>`: server-sent events, the default. Pages use `GET /v1/events` the same way.
- `GET /v1/ws?agent=<id>`: a WebSocket. A client that cannot send an Authorization header sends `{type: "auth", token}` as its first frame, and acknowledges with `{type: "ack", card}`. The client sends `{"type":"ping"}` every 20 seconds and gets `{"type":"pong"}`. An inbox closes a socket that sends nothing for 60 seconds, and the laptop build also sends WebSocket ping frames every 15 seconds.
- `GET /v1/poll?agent=<id>&wait=25`: a long-poll that returns `{events}` at the first answer, or after `wait` seconds.

Each stream sends a `beat` event every 2 seconds, so a client can tell a quiet inbox from a dead one. The inbox reports an agent offline 2 seconds after its last connection closes, so a reconnect or the next poll does not flicker its presence.

`GET /v1/info` returns `{"name":"your-attention","protocol":1,"id":"<inbox id>","pair":"/v1/pair"}`. The id stays the same over every link to the inbox.

## One message over several links

A client may use several links to one inbox, such as a direct link and a relay. It checks that each link reports the same `id` as the first link, or as the id that pairing saved, and skips any other.

A write may include an `x-message-id` header of 8 to 64 characters from `[A-Za-z0-9_-]`. The inbox applies the first request with that id from that client, and answers every later one with the stored result and `x-message-id-replayed: 1`. It forgets an id after 24 hours. The client in `src/client.ts` sends one id per write and keeps it across retries, and it counts an answer once when two links deliver it.

## Links

- `your-attention bridge --upstream <url>` runs a proxy on another machine. It forwards each caller's own token and grants nothing by itself. With `--mdns`, the bridge advertises the upstream inbox id.
- `your-attention offer ssh <host>` opens a reverse SSH tunnel, so agents on that host connect to `http://127.0.0.1:4815`.
- `your-attention relay` runs a relay on a public machine. `your-attention serve --relay <url>` dials out to it over a WebSocket, so the inbox is at `<relay>/i/<inbox id>/` with no open port. The relay key in `YOUR_ATTENTION_RELAY_KEY` only registers inboxes. Every request through the relay still needs the inbox's own token.

## Hooks and extensions

An extension dials in like an agent: `GET /v1/extensions/stream?name=<name>&hooks=<a,b>&timeoutMs=<ms>&policy=fail-open|fail-closed`, with an `extension` or `owner` token. Hook calls use their own messages, version 1, separate from the agent messages:

| Hook | When | What an extension may do |
| -- | -- | -- |
| `card.created` | Before the person sees a new or revised agent card. The call includes the card and the presence of the person. | Answer `POST /v1/hooks/<call id> {verdict, reason}` with `pass`, `hold` or `return`. |
| `answer.saved` | After the person saves an answer. | Observe only. |
| `person.changed` | When a page opens, closes, hides or shows another card. | Observe only. |

While an extension checks a card, the card is `in-triage` and the person does not see it. Every extension on the hook must pass the card. `return` closes the card as `returned` and sends the agent a `returned` event with the reason. `hold` keeps the card `held` until the owner releases it with `POST /v1/cards/<id>/release`.

A hook call without a verdict by its deadline follows the policy: `fail-open` passes the card, and `fail-closed` holds it. The card shows the extension and the reason. With no extension on `card.created`, cards go straight to the person, and an extension that connects later screens the cards still waiting. The platform alarm resolves deadlines, so the inbox itself doesn't set timers.

`POST /v1/webhooks {hook, url}` sends observe-only hook calls to an https service. Each call has the header `x-your-attention-signature: sha256=<HMAC-SHA256 of the body>`, keyed with the secret that the create call returns once.

## The triage extension

`your-attention triage` checks that each card states a goal, the options that the agent weighed, evidence, and a recommendation. It also searches earlier answers, and returns a card that an earlier answer covers. By default it uses OpenRouter, with the key from `your-attention triage login`, an OAuth PKCE sign-in. `--judge-cmd "claude -p"` uses a coding harness in print mode instead, and `--judge-url` uses any OpenAI-compatible endpoint. A judge that fails or answers in an unreadable form passes the card. `your-attention service triage` writes a launchd or systemd unit for it.

## Person presence

Each page opens a WebSocket at `/v1/ws?page=1&viewer=<page id>`, signed in with its cookie, and falls back to `GET /v1/events?viewer=<page id>` when the socket never opens. The page socket sends the same events as the stream. The page sends `{"type":"ping"}` every 2 seconds and gets `{"type":"pong"}`. Each page reports `POST /v1/person/<page id> {visible, active, focus}`. The inbox combines the pages into `{pages, visible, activeAt, focus}` at `GET /v1/person`, for the owner and extensions. With two people on one inbox, each page counts.

## Clients and tokens

Each client sends `Authorization: Bearer <token>`. A token has one of three roles:

- `owner` reads every card and answers them. The built-in page and other front-ends use it.
- `agent` posts cards and receives the answers to them. It can also search past answers.
- `extension` reads every card and the presence of the person, and answers hook calls. Triage uses it.

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
| `agent` | The session that receives the answer, such as `claude:<session id>`, `pi:<session id>` or `opencode:<session id>`. |
| `kind` | `ask` (the default), `blocked` for a harness that waits on a prompt, or `system` for cards the inbox posts. |
| `title`, `text`, `recommendation` | The question, its context, and what the agent would do. |
| `options`, `multiple` | Answer options as `{id, label, description}`. The person picks with the `choice` field. |
| `questions` | Claude Code `AskUserQuestion` questions. Field `q0` answers the first one. |
| `body` | OpenUI Lang source for a card that brings its own widgets. A body with its own `Form` statements keeps each form where the agent placed it, between text and tables, and the page ignores `options` and `questions`. The page adds a comment box, **Send answer** and **Skip for now** below the body. When the body has a field of its own named `comment`, the answer joins its text and the comment box text, the body's first. One send carries the values of every form, by field name. **Your answer** shows each field's label and the labels of the choices picked. |
| `html` | The agent's own HTML and scripts. The page shows it in a frame with `sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"`. After the card's own CSS, the page adds the inbox's text styles: its font, weights, spacing, text size, background and text color, and monospace for code. The card keeps its layout, and every HTML card reads like the rest of the inbox. The frame reports its content height, and the page sizes the frame to fit, up to 20,000 pixels, so the page is the only scroll. A link in the frame opens in a new tab, outside the sandbox and with no reference back to the inbox page. The card's warning says so, because a script in the card picks that address. `allowHtml` is off by default. Then the card offers **Show this card**, for this card only, and **Always show HTML cards**, which turns the setting on. A card in a frame offers to turn the setting off. The page adds a comment box, **Send answer** and **Skip for now** below the frame. **Send answer** asks the frame for every named `input`, `select` and `textarea`. Each radio group gives the picked value, and check boxes give the list of checked values. **Send answer** leaves empty fields out. A script in the frame can also send the answer with `yourAttention.answer(values, comment)`, and the comment box text joins that comment. |
| `attachments` | Up to 10 files, each `{src, name, alt}`. `src` is an https URL or a base64 `data:` URL of at most 8 MB. |
| `template` | `{name, version, vars}`: the inbox fills the body from a saved template, replacing each `{{name}}` with the JSON string of its value. |
| `status` | A state label the agent sets, such as `waiting on CI`. |
| `expiresAt` | When the card stops waiting, in epoch milliseconds. The alarm closes it as `expired`. |
| `rating` | How much the card matters to the agent, from 1 to 5. Priority rules can read it. |
| `screen` | The terminal screen of a blocked agent. |
| `priority` | The id of a priority level: `now`, `soon` (the default) or `later` unless the levels changed. |
| `origin` | Where the session runs: `harness`, `session`, `name`, `host`, `cwd`, `herdrPane`, and the labels of the herdr workspace and tab, `herdrWorkspace` and `herdrTab`. The integration fills it in when the agent posts, and the inbox keeps each field to 200 characters. |
| `from` | A label the agent picks for itself, such as `the release agent`, at most 80 characters. It changes nothing about access: only the token that posted a card can change that card. |
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

The page renders `text` as Markdown: headings, lists, block quotes, fenced code, tables, inline code, bold, italic, and links to http, https and mailto addresses. A bare http or https address becomes a link, and a line break stays a line break. A link with any other scheme shows its label only. OpenUI renders `recommendation`, and reads Markdown there too. Text in `text` links to another card with `[[card-id]]`. The page shows the title of the linked card and previews its text on hover. Below the card you have open, it lists the cards that link to it.

## Attachments

The inbox keeps the bytes of each `data:` attachment in its blob store, R2 in the Cloudflare build and files on disk on a laptop, and the card keeps a reference `{id, name, type, size, alt}`. It stores the bytes before it commits the card, so the card changes in one step. Replacing a card's attachments deletes the old files.

An inbox built with `uploadLimitBytes` counts the bytes of every file it stores and refuses a card with 413 once a post would pass the limit. Each file counts as at least 64 KB, so tiny files cannot make unlimited blob writes. The count covers the inbox's whole life, so the count doesn't go down when a file is deleted, even by `reset`. A post that fails gives back the bytes it counted. The Cloudflare build sets the limit from `UPLOAD_LIMIT_BYTES`, 100 MB in `wrangler.jsonc`, and the laptop inbox has none.

A file the blob store no longer has, such as one R2 deleted after 30 days, answers 410. The card still lists it. An inbox built with `attachmentReadsPerDay` serves each client that many files a day and answers 429 after, before it reads the file.

A card's attachment may carry a `ref` only to a file the card already has, so a client keeps its files when it reposts a card. A `ref` to any other file is refused with 400.

## Size limits

Every inbox applies these:

- A card is at most 256 KB of UTF-8 as stored, without its files, replies and history.
- A title is at most 300 characters, and an agent id at most 80.
- A template or widget source is at most 64 KB, and each name keeps at most 50 versions.
- A reply is at most 4,096 characters, and a card takes at most 200 replies.
- An inbox takes at most 5 webhooks.
- A request body is at most 16 MB for a card post, 4 KB on the routes open without a token, and 1 MB elsewhere. The inbox reads `content-length` first, and stops reading a body that grows past the limit.

An inbox built with `storageLimitBytes` refuses writes with 507 while it stores more than the limit. It still takes deletes, `reset`, `archive`, answers, closes, sign-in and presence reports, so the owner can make room.

A pairing request and its card go a day after the request. An approved token that the client has not collected within 10 minutes goes from storage.

`GET /v1/attachments/<id>` serves the bytes to owner and extension tokens, and to the client that posted the card. Images, PDF, Markdown, text, CSV and JSON come back inline, and every other type as a download with `content-type: application/octet-stream`. Each response has `x-content-type-options: nosniff` and a Content Security Policy that blocks scripts.

## Templates

`POST /v1/templates {name, source, feedback}` saves a new version of a template. `GET /v1/templates` lists them, and `GET /v1/templates/<name>` returns one with every version and the feedback each version answers.

## Widgets

A widget is a reusable part of a card, such as a pull request. Its source is OpenUI Lang with `{{name}}` placeholders, and it must define `root`. `POST /v1/widgets {name, source, feedback}` saves a new version, and `GET /v1/widgets` and `GET /v1/widgets/<name>` read them, as for templates. `card_widget_save` saves one from a coding agent.

A card body or a template places a widget with a line of its own:

```
pr = widget pull-request {"title": "Add stop", "subtitle": "#12", "state": "CI green", "url": "https://github.com/elecnix/your-attention/pull/12"}
```

`pull-request@2` picks a version, and the latest is the default. When the card is posted, the inbox replaces the line with the widget's statements, and fills each placeholder with the JSON string of its value. The widget's `root` statement takes the placed name. Every other statement in the widget gets the placed name as a prefix, so a card can place one widget several times. Widgets can place widgets, up to 8 deep. The inbox answers 400 for a widget that places itself, and 404 for an unknown widget or version. The card records each widget it used, with its version, in `widgets`. A widget gets its values when the card is posted, and has no network access, so the agent revises the card when the pull request changes. `examples/widgets/pull-request.openui` is a pull request widget.

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

## Blocked agents in herdr

`your-attention herdr-blocked` posts a `blocked` card for each agent herdr reports as blocked, and closes the card once the agent moves on. The card shows the agent's screen. When the screen shows numbered choices, such as a permission prompt or a question, the card's `text` is the question and its `options` are the choices. A choice that opens a text box is left out.

You pick a choice and press **Press it in the session**. The sidecar receives the answer on the card's stream, then checks three things before it sends a key to that pane:

1. The agent is still blocked.
2. The answer is for the card's current version. The sidecar posts a new version when the dialog changes, and keeps the version while only the rest of the screen changes, such as a clock.
3. The dialog on the screen still matches the card. The choices match the card. The sidecar also reads the lines above the choices, up to the dialog's top border, and requires them to equal the lines on the card's screen. The same choices for another command are another question.

If all three hold, the sidecar sends the choice's number with `herdr agent send-keys`. If the screen then still shows the same dialog, the number only moved the selection, so it sends Enter. If a check fails, no key goes out, and the card closes with the reason. The sidecar sends keys only to the card's own pane.

## Clearing the inbox

`POST /v1/archive` clears the cards you dealt with: answered, retracted, self-answered, resolved or expired, with no agent reply you haven't seen. A cleared card leaves `/v1/state`, and `card_search` still finds it with its answer, so agents can check past answers before they ask again. A revision or a reply from its agent brings the card back. The page shows a **Clear answered or closed cards** button when there are any, and `your-attention clear` does the same from the command line. Only the owner can clear.

`POST /v1/reset {"confirm": "reset"}` removes every card, answer and attached file, and it cannot be undone. Tokens, templates, widgets, settings and guidance stay. Only the owner can reset, and `your-attention reset --yes` calls it.

## Delivery

An agent opens `GET /v1/stream?agent=<id>`, and the inbox reports the agent online until the last such stream closes. The inbox sends each undelivered answer for that agent and that token as an `answer` event:

```json
{ "type": "answer", "id": "5f2a9c01d3e4", "card": { "id": "c1", "title": "Use SQLite?" }, "answer": { "values": { "choice": "o1" }, "comment": "yes" } }
```

The event above is trimmed to the fields an agent reads. The `id` is a receipt: the Claude Code channel watches the session transcript for it before it sends the acknowledgment.

The OpenCode plugin follows one stream per session, as agent `opencode:<session id>`: each session that calls a card tool, and each session from before a restart that still has an open card. It sends each answer into its session with OpenCode's `promptAsync`. OpenCode starts a new turn when the session is idle, and queues the message behind a turn that runs. The plugin acknowledges the answer when OpenCode's `chat.message` hook shows the receipt in the conversation.

A client adds `instance=<id>` to the stream, `/v1/ws` or `/v1/poll` address, with one id per process that stays the same across its reconnects. The inbox records the instance that received each answer. When a different instance of the agent connects, such as a session restarted before it read an answer, the inbox sends it every answer that was delivered but never read. A reconnect from the same instance gets nothing twice.

Answers for an offline agent wait. `GET /v1/dead-letters` lists them, and `POST /v1/cards/<id>/claim {agent}` hands one to a successor session.

## Pages

`GET /v1/state` returns every card except the cleared ones, answer, presence record and card state. `GET /v1/events` sends `change {card}`, `presence {agent, online}`, and `code` when the page source changed. A page refetches the state on each `change`. On `code`, a hidden page reloads at once. A page someone looks at reloads once nothing has happened on it for 3 seconds and no field has focus, so it never takes a field away while the person types. Drafts and the scroll position come back after the reload. When the agent revises a card while the person answers it, the form stays in place with its text and focus, and shows the new version. A pick records the option's id and label, so a revision that drops or relabels the picked option drops that pick.

The tab icon is the ✋ emoji, `web/favicon.svg`. While a card waits for you, the page switches it to `web/favicon-waiting.svg`, which adds a red dot.

The phone button, left of the GitHub mark, opens a QR code that opens the inbox on a phone, signed in. The page gets a sign-in code from `POST /v1/sign-in-codes`, which only the owner may call, and the QR code encodes the page's own address with `#signin=<code>`. The phone sends the code to `POST /v1/login {code}`, which gives it its own owner token, named for the time it signed in, so you can revoke the phone alone. A code works once, for five minutes, and an owner may hold five at a time. The dialog gets a fresh code 30 seconds before the current one expires. The owner token never goes in the QR code. When the page runs on `localhost` or `127.0.0.1`, the dialog reads `GET /v1/addresses`, which only the owner may call. Its answer lists the laptop's `.local` name, then its IPv6 and IPv4 addresses on the local network, such as `http://laptop.local:4815`, when it listens on every interface. It leaves out tunnels, VPNs and container bridges. `serve` listens on `::` by default, which takes IPv4 and IPv6, and on `0.0.0.0` on a machine without IPv6. A VPN that sends the network's IPv4 into its tunnel often leaves IPv6 alone, so a phone still opens the inbox over IPv6. The QR code then encodes the first of them, and the dialog shows the next one in case the phone cannot resolve `.local` names. An inbox that listens on `127.0.0.1` only lists none, and the dialog says a phone cannot open it. `qrcode-generator` draws the code, served at `vendor/qrcode.mjs`.

On a screen 760 pixels wide or less, the page puts the queue below the card, and a button above the card says how many cards wait and scrolls to the queue. The bar scrolls away with the page. A connected inbox shows as a dot, and a lost connection keeps its words. Fields use 16-pixel text, so iOS does not zoom into them.

## Search

`GET /v1/search?q=<words>` matches each word as a prefix, over card text and answer comments. The laptop build uses SQLite FTS5.

## Discovery

On a LAN the inbox advertises `_cardinbox._tcp` over mDNS, with the TXT record `v=1`, `id=<inbox id>`, `pair=/v1/pair`. `your-attention serve --no-mdns` turns the advertisement off.

## Starting and stopping the laptop build

`your-attention serve` runs the inbox in the foreground. `your-attention start` runs `serve` in the background with the same options, and returns once the inbox answers. Its output goes to `serve.log`. The inbox writes its address to `server.json` and removes the file when it closes.

`your-attention stop` sends `POST /v1/shutdown` with the owner token, and waits until the inbox no longer answers. Other tokens get 403. When a launchd or systemd service runs the inbox, `stop` stops the service, because the service manager restarts an inbox that exits. The Cloudflare build has no shutdown route.

## The Cloudflare build

`src/cloudflare/worker.ts` runs the same core on Workers. Each inbox is one Durable Object, `InboxObject`, which keeps its state in the object's SQLite database, with FTS5 for search, and file bytes in R2 under the object's id. The object hibernates when idle:

- Each agent WebSocket keeps its agent id and token in the socket attachment, so the object reconnects every socket to the inbox when it wakes, and presence stays as it was.
- The object answers `{"type":"ping"}` with `{"type":"pong"}` through the runtime's auto-response, which does not wake it. An alarm every 30 seconds closes a socket whose last pong is older than 60 seconds.
- The object sets its alarm for the next moment `sweep()` has work, from `nextDeadline()`, and for no other time.

With `MODE` set to `single`, the Worker serves one inbox, whose owner token is the `OWNER_TOKEN` secret. With `MODE` set to `hosted`, it serves many:

- `POST /new {invite}` takes one use of an invite code and returns the address of a new inbox and its owner sign-in link. KV keeps `invite:<code>` with the number of uses the operator allows, and a registry Durable Object counts the uses taken, one request at a time.
- Each inbox is at `/i/<id>/`. The person bookmarks the address and keeps it private.
- The operator manages invites with `wrangler kv key put invite:<code> <uses> --binding INVITES --remote`. Codes need 20 characters or more, such as the 128 random bits of `openssl rand -hex 16`, and the Worker refuses a shorter one before any lookup.
- An address is 20 random hex digits and 12 hex digits of an HMAC over them, keyed by the `INBOX_ID_SECRET` secret. The Worker checks the HMAC, so a guessed address costs no KV read and reaches no Durable Object. Changing the secret makes every address invalid.
- Each inbox's sign-in cookie has the path `/i/<id>/`, so signing in to one inbox leaves another one's cookie alone.

The Worker counts each request before it reaches a Durable Object, with two Workers rate limiting bindings, and answers 429 past them. `LIMITER` counts signed-in calls per inbox and client address, 300 a minute. `ANON_LIMITER` counts calls without a token per client address, 100 a minute, including `POST /new`. So a stranger without a token can't use up the owner's budget. Both limits are approximate, since Cloudflare counts per location. The hard limits are the budgets each inbox applies itself:

- 100 MB of files over the inbox's life, from `UPLOAD_LIMIT_BYTES`.
- 20 MB of database storage, from `STORAGE_LIMIT_BYTES`. The Durable Object adds up its rows once, then adds or subtracts the size of each write.
- 2,000 file downloads a day for each client, from `ATTACHMENT_READS_PER_DAY`.

R2 deletes each file 30 days after its upload, by the lifecycle rule in `cloudflare/main.tf`.

An open request keeps a Durable Object awake and billed, so the Cloudflare build answers `GET /v1/events`, `/v1/stream` and `/v1/poll` with 410. Agents and pages use hibernating WebSockets, whose pings get their answer from the runtime without waking the object. Each inbox keeps at most 64 sockets. A socket that has not signed in 10 seconds after it opened closes at the next alarm, and a socket that sends more than 120 frames in a minute closes with 4429. In single mode, each Worker isolate gives the owner token to the inbox on its first request only.

`npm run cloudflare:check` bundles the Worker with a dry-run deploy, and `npm run test:cloudflare` runs the hosted build on `wrangler dev` with local Durable Objects, R2 and KV. The `deploy-cloudflare` workflow deploys it when someone runs it from the Actions tab.
