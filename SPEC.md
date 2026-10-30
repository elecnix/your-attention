# Protocol specification, version 1

This file specifies the messages, card states and delivery rules that every inbox and client follows. The TypeScript types in `src/core/types.ts` mirror it, and the integration tests in `test/integration/` are the conformance suite. A build in another language passes the suite when it serves the same routes.

## Transport and encoding

Messages are JSON over HTTP. Agents receive events in whichever of three ways their environment allows:

- `GET /v1/stream?agent=<id>`: server-sent events, the default. Pages use `GET /v1/events` the same way.
- `GET /v1/ws?agent=<id>`: a WebSocket. A client that cannot send an Authorization header sends `{type: "auth", token}` as its first frame, and acknowledges with `{type: "ack", card}`. The client sends `{"type":"ping"}` every 20 seconds and gets `{"type":"pong"}`. An inbox closes a socket that sends nothing for 60 seconds, and the laptop build also sends WebSocket ping frames every 15 seconds.
- `GET /v1/poll?agent=<id>&wait=25`: a long-poll that returns `{events}` at the first answer, or after `wait` seconds.

Each stream sends a `beat` event every 2 seconds, so a client can tell a quiet inbox from a dead one. The inbox reports an agent offline 2 seconds after its last connection closes, so a reconnect or the next poll does not flicker its presence.

`GET /v1/info` returns `{"name":"your-attention","protocol":1,"id":"<inbox id>","pair":"/v1/pair","checks":{"diagrams":true,"body":true}}`. The id stays the same over every link to the inbox. `checks` says what the inbox checks itself before it takes a card, as [Checks on the client](#checks-on-the-client) describes. An inbox whose answer has no `checks` checks both.

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

Each page opens a WebSocket at `/v1/ws?page=1&viewer=<page id>&unlock=<unlock token>`, signed in with its cookie, and falls back to `GET /v1/events?viewer=<page id>` when the socket never opens. The page socket sends the same events as the stream. The page sends `{"type":"ping"}` every 2 seconds and gets `{"type":"pong"}`. Each page reports `POST /v1/person/<page id> {visible, active, focus}`. The inbox combines the pages into `{pages, visible, activeAt, focus}` at `GET /v1/person`, for the owner and extensions. With two people on one inbox, each page counts.

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

## The PIN

Whoever holds the inbox address or a sign-in link could answer as the person, and each answer goes straight into an agent's session. With a PIN of 4 digits set, that credential opens nothing until the browser tab types the PIN.

The inbox refuses a request with 423 `{error, locked: true}` when the request signs in with the cookie, or with an owner token that someone can copy as a link, and doesn't send a live unlock token. Such owner tokens come from sign-in codes, from `POST /new` on the hosted service, and from the single-mode `OWNER_TOKEN`. A locked caller may call the PIN routes below. It may also read `GET /v1/attachments/<id>`, since an image tag can't send a header and the attachment ids show up only in what an unlocked page reads. Owner tokens with `pinExempt` skip the PIN as bearer tokens. The laptop's `owner-token` file has it, and so does each token paired with `role: owner`, which the person approved on the page. Agent and extension tokens never need the PIN.

| Route | Who | Does |
| -- | -- | -- |
| `GET /v1/pin` | owner | `{set, salt, iterations, newIterations, neverAsk, unlocked, lockedUntil, triesLeft, exempt}` |
| `POST /v1/unlock {key}` | owner | `{unlock, idleMs}`, or 401 `{triesLeft}`, or 429 `{lockedUntil}` with `retry-after` |
| `PUT /v1/pin {key, salt, iterations, current}` | owner | Sets the PIN. A gated caller sends `current` when a PIN exists, and gets a fresh `unlock`. |
| `DELETE /v1/pin {current}` | owner | Removes the PIN, with the same rule for `current`. |
| `PUT /v1/pin/never-ask {neverAsk}` | owner | Stores whether the page and the CLI offer to set a PIN. |
| `POST /v1/lock` | owner | Ends the unlock token in the request's header. |

The page sends its unlock token in the `x-your-attention-unlock` header. The page socket and the event stream can't send headers, so they put it in `unlock=`. The page keeps the token in `sessionStorage` under `ya-unlock:<page path>`, never in `localStorage` or a cookie, so closing the tab ends it. Each unlock token belongs to the owner token that unlocked, and the inbox stores its SHA-256 hash in `meta`. The inbox ends a token after 12 hours without a request, at `POST /v1/lock`, when someone revokes its owner token, and when the PIN changes or goes. Then the inbox closes each page socket and event stream that opened with it, with code 4423 on a socket. The message memory never keeps a PIN route's response.

The PIN never leaves the client. The page, the landing page and the CLI derive a key from it with PBKDF2-SHA256, 32 bytes sent as 64 lowercase hex digits. They send the key in `key` and `current`, never the PIN:

- To unlock, or to prove the current PIN, the client derives with the `salt` and `iterations` that `GET /v1/pin` returns for the PIN that is set.
- For a new PIN, the client draws a random 16-byte salt and derives with the `newIterations` that `GET /v1/pin` returns. It sends the key with the salt and the count, and the inbox answers 400 for any other count.

Both builds hand out 800,000 iterations, about 100 ms on a laptop, so the hosted inbox doesn't run a slow hash in its 10 ms of CPU time. `web/pin-key.js` derives the key on the page, and `src/core/pin.ts` derives the same key in Node. A browser gives Web Crypto to secure origins only, so a phone that opens a laptop inbox at a plain-HTTP address derives the key in plain JavaScript. That takes about 2 seconds on a laptop and 7 seconds on a CPU four times slower, so the page shows how far it got. The inbox keeps the PIN in `meta` under `pin` as `{key, salt, iterations, setAt, neverAsk}`, where `key` is the SHA-256 of the derived key. A laptop PIN set before clients derived keys is stored as `{hash, salt, iterations}`, where `hash` is the derived key itself, and it keeps working: the inbox compares against the SHA-256 of `hash`. The comparison takes the same time wherever the bytes differ. The inbox never logs or returns a PIN or a key.

Each wrong key counts in `meta` under `pin-tries` before the hash runs, so tries sent at once all count. The fifth wrong try starts a lockout of 1 minute. Each later lockout lasts twice as long as the one before, up to 24 hours, and even the right PIN waits it out. The right PIN, a new PIN, and removing the PIN reset the count, and a restart keeps it. With an exempt token, `your-attention pin reset` sets or removes a forgotten PIN without `current`, during a lockout too.

The page offers to set a PIN each time it opens, as long as the inbox has none and `neverAsk` is false. It shows **Skip** and **Never ask again**. In a terminal, `serve` and `start` ask the same, with the PIN typed hidden and twice. A run without a terminal never asks. `your-attention pin status|set|reset|clear` reads and changes the PIN with the `owner-token` file, or with the token of a machine paired as owner. `set` refuses to replace a PIN, and `reset` replaces it without the old one.

## Cards

An agent posts `POST /v1/cards` with these fields. Only `agent` and `title` are required.

| Field | Meaning |
| -- | -- |
| `id` | 1 to 80 characters: letters, digits, dots, colons, dashes or the `_` character. Posting the same id again revises the card and adds 1 to its `version`. |
| `agent` | The session that receives the answer, such as `claude:<session id>`, `pi:<session id>` or `opencode:<session id>`. |
| `kind` | `ask` (the default), `blocked` for a harness that waits on a prompt, or `system` for cards the inbox posts. |
| `title`, `text`, `recommendation` | The question, its context, and what the agent would do. |
| `options`, `multiple` | Answer options as `{id, label, description, recommended}`. The page shows each option as a box the person clicks, with its description inside, as inline Markdown. The person picks with the `choice` field. An agent marks its recommended option with `recommended: true`. A card without `multiple` takes one at most, and the inbox answers 400 to a second one. The `card_post` tool takes each option as `{label, description, recommended}` or as a plain label. |
| `questions` | Claude Code `AskUserQuestion` questions. Field `q0` answers the first one. |
| `body` | OpenUI Lang source for a card that brings its own widgets. A body with its own `Form` statements keeps each form where the agent placed it, between text and tables, and the page ignores `options` and `questions`. The page adds a comment box, **Send answer** and **Skip for now** below the body. When the body has a field of its own named `comment`, the answer joins its text and the comment box text, the body's first. One send carries the values of every form, by field name. **Your answer** shows each field's label and the labels of the choices picked. |
| `html` | The agent's own HTML and scripts. The page shows it in a frame with `sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"`. After the card's own CSS, the page adds the inbox's text styles: its font, weights, spacing, text size and background, the body text color with bright headings and bold words, and monospace for code. The card keeps its layout, and every HTML card reads like the rest of the inbox. The frame reports its content height, and the page sizes the frame to fit, up to 20,000 pixels, so the page is the only scroll. A link in the frame opens in a new tab, outside the sandbox and with no reference back to the inbox page. The card's warning says so, because a script in the card picks that address. `allowHtml` is off by default. Then the card offers **Show this card**, for this card only, and **Always show HTML cards**, which turns the setting on. A card in a frame offers to turn the setting off. The page adds a comment box, **Send answer** and **Skip for now** below the frame. **Send answer** asks the frame for every named `input`, `select` and `textarea`. Each radio group gives the picked value, and check boxes give the list of checked values. **Send answer** leaves empty fields out. A script in the frame can also send the answer with `yourAttention.answer(values, comment)`, and the comment box text joins that comment. |
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

An owner client sends the answer with `POST /v1/cards/<id>/answer {values, comment, delivery, version, images}`. Every field is optional, so an empty answer is valid. `delivery` is one of:

- `default`: steer the current turn, or start a new turn when the agent is idle.
- `steer` or `followUp`: the matching delivery in the harness.
- `force`: set by `POST /v1/cards/<id>/force` for an answer the model has not read.

A new answer replaces the old one and keeps it in `previous`.

`images` is a list of up to 10 pasted images, each `{src, name, field}`. `src` is a base64 `data:` URL of a PNG, JPEG, GIF or WebP image of at most 8 MB, and `field` is the field the person pasted it into, such as `comment` or `q0`. The inbox answers 400 for any other type or an https URL, 413 for an image over the limit, and 400 for an image on a secret card. It stores the bytes in the blob store before it saves the answer. They count against `uploadLimitBytes` like a card's files. The answer's `images` keeps a reference `{id, name, type, size, field}` for each one. The answer route takes a body of up to 16 MB, as the card post does. A card's agent token reads each image at `GET /v1/attachments/<id>`, and no other agent token does. Replacing an answer keeps the earlier images in `previous`, and `reset` deletes them.

In the page, Command+V on an image in the general comment box, in a question's comment field or in any text field of the card on screen adds a thumbnail under that field. A × button removes it before the person sends. Text on the clipboard still pastes as text. A pasted file that isn't one of the four image types, or is over 8 MB, shows a message under the field, and the page doesn't add it. **Send answer** sends the images with the answer and clears them. A secret card's fields don't take images.

An integration saves each image of an answer into `~/.your-attention/images/<agent>/<card>/`, readable by this user only (mode 0600 in a 0700 folder), and the event gives the file's path: `Image pasted in comment: <path>`, or `Image: <path>` when the image has no field. Claude Code, pi and OpenCode all do so before they tell the model.

## Secret cards

A card with `kind: "secret"` asks for one value. It carries `secret: {name, publicKey}`, where `name` is a variable name and `publicKey` is an RSA-OAEP public key as a JWK. The agent keeps the private key in memory.

To seal the value, the page encrypts it with a new AES-256-GCM key, then wraps that key with the public key. The answer contains `values.sealed`:

```json
{ "alg": "RSA-OAEP-256+A256GCM", "key": "<wrapped AES key, base64>", "iv": "<base64>", "data": "<ciphertext, base64>" }
```

The inbox refuses any other value on a secret card, so plain text never reaches storage. An answer without `values.sealed` declines the request. A page on plain HTTP from another machine cannot seal, because browsers give Web Crypto to secure origins only.

### Body check

The OpenUI parser drops a statement it can't read. An unclosed string also hides every later statement from it. The page would then draw part of a body and say nothing. The laptop inbox reads each body with that parser, `@openuidev/lang-core` 1.0.1, and with the page's own component list. It refuses a body with 400 when a string never closes, when a statement uses a name the body never defines, when a call breaks a component's signature, or when the body has no `root` statement. The check runs after the inbox fills a template and places widgets, on `POST /v1/cards` and on `card_patch`. Its message lists each fault on its own line and names the statement:

```text
the page cannot draw all of this body:
- `f1` (line 4) has a string that never closes, so the page drops it and every statement after it. Open and close each string with a plain quote, and escape only for a quote inside a string.
- `f2` is used but never defined.
```

`scripts/openui-library.ts` writes the component list from the page itself, and a browser test fails when the two differ. `web/body-faults.js` turns the parser's result into these faults. The inbox runs it on the result of `@openuidev/lang-core`, and the page runs it on the result its Renderer reports, so both find the same faults. On the hosted inbox, the client and the page check bodies in its place, as [Checks on the client](#checks-on-the-client) describes.

Some cards stored before the check have a body the page can't draw whole. For such a card, the laptop inbox's `GET /v1/cards/<id>` adds `bodyFallback: {body, faults}`, which the inbox computes and never stores. When a card has no `bodyFallback`, the page and the terminal client read the body themselves and compute the same fallback. Its `body` starts with the statements before the first broken one, unchanged. A code block of the source from the broken statement on comes last. The page draws it below a warning, with the source lines wrapped and the comment box with **Send answer** below. A revision with a body that draws whole drops `bodyFallback`.

The fold under a card that follows another one shows the earlier card's text as Markdown, as the card itself does.

## Editing cards

`POST /v1/cards/<id>/patch {edits: [{old, new}], field}` edits one field, `text` by default or `body` when the card has one. Each `old` must occur exactly once, or the inbox refuses the whole patch with 409. A revision, by patch or by posting the same id, adds 1 to `version` and keeps the version before it in `history`, up to 20 versions.

An agent may also revise a card the person answered, or one that is closed. The inbox saves the revision, but the card stays in **Sent**, so the person isn't notified and won't answer it again. The reply to `POST /v1/cards` or to the patch then has a `warning` field. It says so, and suggests a new card with `follows` set to the old one. The card tools add the warning to their reply.

`POST /v1/cards/<id>/status {status}` sets the agent's state label. An empty label clears it.

The page renders `text` as Markdown: headings, lists, block quotes, fenced code, tables, inline code, bold, italic, and links to http, https and mailto addresses. A bare http or https address becomes a link, a `file:` address becomes a file link, as described below, and a line break stays a line break. A link with any other scheme shows its label only. On every kind of card, `recommendation` sits below `text`, with a **Recommendation** label and an accent-colored line at its left. It reads as Markdown, as large as `text`. It has no fill, so it never looks like a picked option. The page and the terminal client find the recommended option with `recommendedOptions` in `web/answers.js`. It takes the options marked `recommended`. When the card marks none, it looks for an option label at the start of the recommendation, followed by a sentence end, a comma, a colon or the end of the text, ignoring case and Markdown emphasis. If several labels match, it takes the longest. So "Go ahead. A read-only key…" recommends the **Go ahead** option, and "Going ahead" recommends no **Go** option. The recommended option shows a **Recommended** tag below its description, behind the same accent line. The tag has no fill and leaves the option's border alone, so a recommended option looks picked only once the person picks it. When exactly one option is recommended, the recommendation renders inside that option, under the tag, and the page draws no box for it above the options. Inside the option, a recommendation that starts with the option's label drops the label, the emphasis around it, and the punctuation and spaces after it, and its first letter becomes a capital. So "Go ahead. A read-only key…" reads "A read-only key…" under the tag, and a recommendation that is only the label shows the tag alone. With no recommended option, or several on a `multiple` card, the box stays. A card whose page doesn't draw its options, such as an HTML card or a body with its own `Form`, keeps the box too. A ```` ```mermaid ```` fenced block in `text` or `recommendation` draws as a diagram, as [Diagrams](#diagrams) describes. A field label in a body reads inline Markdown too, so a `FormControl` label can link to the pull request it asks about. Text in `text` links to another card with `[[card-id]]`. The page shows the title of the linked card and previews its text on hover. Below the card you have open, it lists the cards that link to it.

The page copies code with a click, so an agent puts text the person should copy, such as a command or an approval sentence, in code. Each fenced block, in `text`, `recommendation`, a reply, a Markdown attachment, a `CodeBlock` or a `TextContent`, has a Copy button at its top right. The button stays dim until the pointer is over the block or the button has focus, and it copies the block's text exactly, with no newline added. A click on inline code, in the same places and in field labels, copies its text. A click on inline code inside a link follows the link and doesn't copy. For about 1.5 seconds, the button reads **Copied**, and a **Copied** note shows over inline code. A diagram that draws has no button. When a diagram fails to draw, the page shows its source with a button. The page writes with `navigator.clipboard`, which a browser offers only on a secure page, such as `http://127.0.0.1`. On a page at a LAN address, such as `http://laptop.local:4815`, it copies through a hidden text area and `document.execCommand('copy')`. The terminal client doesn't copy code, because its Tab key moves between links, fields and buttons and skips code.

Agents point at another agent's session with a herdr link, `[label](https://herdr.invalid/v1/<kind>/<id>)`. The kind is `agent`, `pane`, `tab` or `workspace`, and herdr's session fingerprint may come before it. An orchestrator uses one to report on a blocked agent in another tab. The page shows the link as a terminal chip in the card's text, body, Markdown files and HTML. A click keeps the page where it is. The page sends the link to `POST /v1/focus`, which only the owner may call. The inbox then runs `herdr agent focus`, `tab focus` or `workspace focus` on this computer. For a shell pane without an agent, the inbox opens the pane's tab. The id uses letters, digits, `_`, `:`, `.` and `-`, and never starts with a dash. A hosted inbox has no herdr, so it answers 501 and the chip shows the error.

Agents point at a file on their own machine with a `file:` address, bare as `file:///Users/me/report.html` or as a Markdown link, `[the report](file:///Users/me/report.html)`. The address is percent-encoded, so a space in a path is `%20`. A browser refuses to open a `file:` address from an `http` page, so the laptop inbox serves the file at `GET /v1/cards/<id>/file?path=<path>`, where `path` is the decoded path of the address. The page links a file address there when `GET /v1/cards/<id>` marks the card with `localFiles: true`. The laptop inbox sets that mark for the owner when the card's `origin.host` matches the computer's host name. Without the mark, as on the hosted inbox or for a card from another computer, the page and the terminal client show the path as inline code, which a terminal can open itself. A file address that names another host, such as `file://server/share`, stays text.

The route serves the owner only, and it serves a file under these rules:

- The card's `text` or `recommendation` must contain a `file:` address whose decoded path is `path`, after dot segments resolve. A path that the card doesn't contain answers 403. So the agent that posted the card chooses what the route exposes, as it does with attachments.
- The card's `origin.host` must match the computer's host name, or the route answers 403.
- A directory, a missing file, or anything else that isn't a regular file answers 404. A file over 8 MB, the attachment limit, answers 413.
- The extension sets the type. HTML comes back as `text/html`, and text, Markdown, logs and CSV as `text/plain`, with JSON, images and PDF as their own types. The route serves any other extension as a download.
- Each response has `x-content-type-options: nosniff` and the Content Security Policy of an attachment, which starts with `sandbox`. So a served HTML report runs in an opaque origin, without scripts, and can't read the inbox's cookie or its storage. A PDF goes without `sandbox`, as an attachment does, because browsers refuse to show a sandboxed PDF.
- The page opens the file with a ticket. At a click it opens a new tab, then asks `POST /v1/cards/<id>/file-ticket {path}`, which only the owner may call. The inbox checks the rules above and answers 201 `{ticket, expiresAt}`. The tab then loads `GET /v1/cards/<id>/file?ticket=<ticket>`. A ticket opens one file once, for its card and path, within 60 seconds, and a used, expired or other card's ticket answers 403. The inbox keeps tickets in memory and never replays the ticket response for an `x-message-id`.

A new tab signs in with the cookie and doesn't send an unlock header, so whether the inbox has a PIN sets what opens a file:

| The inbox | A request without a ticket | A request with a ticket |
| --- | --- | --- |
| has no PIN | serves the file to the cookie, or to an owner token | serves the file once |
| has a PIN | answers 403 to the cookie, and 423 while the cookie is locked. A PIN-exempt owner token still opens the file | serves the file once, even to a locked cookie |

`POST /v1/cards/<id>/file-ticket` follows the PIN gate as other routes do, so a locked page gets 423 and no ticket.

The hosted inbox has no file system, so the route answers 404 there.

In any field of the card on screen, Command+Enter or Control+Enter sends the answer, as the card's Send answer button does. Enter and Shift+Enter add a line. In the queue, a card that waits for you shows a raised hand, and the card on screen shows it filled. **Skip for now** opens the next card in queue order, and wraps around at the end. Sending an answer also opens the card after the answered one, and a skipped card opens again only after the queue wraps around.

The card on screen shows its age at the top right, such as `15 min ago` or `4 h 30 min ago`. Under an hour, the age rounds to 5 minutes. Under a day, it rounds to 10 minutes, and after that to the hour. The page updates the age each minute by the browser's clock. Its tooltip gives the exact sending time and the time of the last revision.

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

A widget version can also carry `when` and `response`, as `POST /v1/widgets {name, source, feedback, when, response}` and `card_widget_save` take them. `when` says when an agent should place the widget and how to fill its values. `GET /v1/guidance` returns the catalog in `widgets`, one line per widget with its name and `when`, then the values it takes. `card_guidance` shows that catalog after the guidance text, so an agent finds a widget the way it finds a skill.

`response` is text for the agent. When the person answers, the inbox fills it and stores it in the answer's `responses`. The agent reads it after the answer fields. `{{field}}` is the answer's value for that field. When the answer has no value for a field, the inbox uses the value that the card placed the widget with, so a prefilled field the person never edits still counts. `{{#field}}...{{/field}}` shows its text when the field is on or filled, and `{{^field}}...{{/field}}` when it is off or empty. A check box group counts as on when one of its items is on. A response can tell the agent what to do next, such as where to post a message the person approved.

The page adds two components to OpenUI's. `Mermaid(source)` draws a diagram, as [Diagrams](#diagrams) describes. `CheckWithText(label, check, [content])` It shows a check box and a label. A click on the label shows or hides the content, such as a `TextArea` the person can edit, and it leaves the box as it was. Hovering the label previews the text of the content's fields. The content stays on the page while hidden, so its fields send their values with the answer. A `FormControl` or a `Card` can hold it.

## Diagrams

A card draws [Mermaid](https://mermaid.js.org) diagrams in two places:

- In `text` and `recommendation`, a fenced block whose first line is ```` ```mermaid ```` draws its lines as a diagram.
- In `body`, the `Mermaid(source)` component draws one. Its source must be a string literal in double or single quotes, such as `flow = Mermaid("flowchart TD\n  A --> B")`, and the inbox refuses a reference to another statement. The inbox reads the body as OpenUI does, so it skips a call in a `//` or `#` comment. A `Card`, `SectionItem`, `TabItem`, `AccordionItem` or `Carousel` can hold it, as for a `CodeBlock`.

Every inbox has the built-in widget `mermaid`, version 1, which places `Mermaid` with its `source` value: `flow = widget mermaid {"source": "flowchart TD\n  A --> B"}`. `GET /v1/widgets` lists it first, with `builtin: true`, and the catalog in `GET /v1/guidance` lists it with the saved widgets. Saving a widget named `mermaid` answers 400.

When an agent posts or patches a card, the laptop inbox parses each diagram with mermaid 11.17.2, after it fills a template and places widgets. That covers `POST /v1/cards`, `card_patch`, and a widget or template that expands into a diagram. The inbox refuses a diagram that does not parse with 400. Its message names where the diagram is and quotes mermaid's error. For a dotted link with text and a pipe label, mermaid's error reads:

```
The Mermaid diagram in text, the diagram on line 3 does not parse, so the inbox did not take the card. Mermaid 11.17.2 says:
Parse error on line 2:
...t TD  A -. text .->|label| B
----------------------^
Expecting 'AMP', 'COLON', 'DOWN', 'DEFAULT', 'NUM', 'COMMA', 'NODE_STRING', 'BRKT', 'MINUS', 'MULT', 'UNICODE_TEXT', got 'PIPE'
```

The check also refuses a diagram over mermaid's limits, which the page would refuse to draw: more than 500 edges, or more than 50,000 characters. A card shows at most 20 diagrams. The inbox checks a card's diagrams before it commits the card, with no await between the commit and the reads it depends on. A widget that changes during the check makes the post answer 409, and the agent posts again.

The laptop inbox parses in its Node process. The hosted inbox doesn't parse diagrams: the posting client parses them in Node with the same mermaid package, as [Checks on the client](#checks-on-the-client) describes. Mermaid's parser calls DOMPurify on labels, and DOMPurify needs a DOM, which Node doesn't have. Where DOMPurify doesn't find a usable DOM, it returns the text unchanged, and `src/adapters/mermaid.ts` gives it that behavior here. It doesn't set a browser global. Mermaid loads on the first diagram, so a process without diagrams never loads it.

The page draws each diagram with `vendor/mermaid.min.js`, a static file that the inbox serves from its own mermaid package. The hosted Worker serves it from its assets and doesn't run it. So the page draws offline, with mermaid 11.17.2, as the check used. When mermaid loads and still can't draw a diagram, the page shows its source and reports it, as [Checks on the client](#checks-on-the-client) describes. A renderer that doesn't load says nothing about the diagram, so the page doesn't report it. It loads the file when it first shows a diagram. It draws with `securityLevel: "strict"`, and with mermaid's `base` theme set from the page's color tokens, so a diagram reads in the light theme and in the dark one, and draws again when the theme changes. A system card shows a Mermaid block as code, since it quotes an agent's words without a check.

## Checks on the client

A hosted inbox runs on the Workers Free plan, which gives each request 10 ms of CPU time. Parsing a large body or a diagram takes longer, so the hosted inbox takes both unchecked, and its `GET /v1/info` says `"checks":{"diagrams":false,"body":false}`. The laptop inbox checks both itself, and says `true` for each. On the hosted inbox, these clients check in its place:

1. The posting client in `src/client.ts`, which every integration and the CLI use, reads `checks` once. When the inbox doesn't check, the client sends `POST /v1/preview` before each post and each patch. Its answer has the `text`, `recommendation` and `body` the inbox would store, after it fills a template and places widgets. The inbox doesn't store them. The client checks them with the laptop inbox's checks, and fails with the same message, before it sends the card. `POST /v1/preview` takes `{card}` for a post, and `{id, edits, field}` for a patch.
2. The page checks what it draws. When mermaid loads and can't draw a diagram, or when a body has faults and the card has no `bodyFallback`, the page sends `POST /v1/cards/<id>/draw-fault {version, renderer, diagrams: [{source, error}], body: [fault]}`. `renderer` is the page's mermaid version. Only the owner may call it.

The inbox takes a report for the card's current version only, and answers 409 for any other. It keeps each diagram whose source the card shows, and answers 400 when the report has none and no body faults. Then it closes the card as `returned` and sends its agent a `returned` event with `by: "The inbox page"`. The reason reads as the laptop inbox's refusal does, and says the inbox sent the card back:

```text
The Mermaid diagram in text, the diagram on line 3 does not parse, so the page could not draw it, and the inbox sent the card back. Mermaid 11.17.2 says:
Parse error on line 2:
```

The inbox ignores a report on a closed or answered card, so a second page that draws the same card doesn't send it back twice. A system card shows its diagrams as source, and the inbox refuses a report on one with 400. A raw HTTP post that skips the client check still gets its error this way, once the page shows the card.

`npm run cpu-budget` measures the CPU time of the hosted request paths, on the largest inputs the inbox takes, against the 10 ms.

## Priority levels

`GET /v1/priorities` returns the levels as `{id, label, definition, rule, color}`. A `color` is `#rrggbb`, and a waiting card raises its hand in its level's color. Decide now is red (`#e5484d`) and Decide soon is dark yellow (`#c9a100`) by default. A default level saved without a color keeps its default color. Agents and the owner replace them with `PUT /v1/priorities`. A `rule` is an expression over the card: `kind`, `agent`, `priority`, `status`, `rating`, `tags`, `blocked`, `answered`, `waitMinutes` and `harness`. The grammar has comparisons, `&&`, `||`, `!`, arithmetic and `in`, and `src/core/expr.ts` parses it without `eval`. A card shows the first level whose rule matches it. Without a match, it shows the level that the agent gave. `GET /v1/state` returns that level per card in `priorities`.

## Card guidance

`GET /v1/guidance` returns `{text, version, widgets}`, with the widget catalog in `widgets`. `POST /v1/guidance {text}` proposes new guidance: the inbox posts a system card that lists the agents it knows, all picked. An owner client approves with `choice: approve` and the `agents` to reach. The inbox then stores the new version and sends `guidance` events to the picked agents that are online. The `hello` event carries the current guidance version, so an agent that was offline can fetch it.

## Settings

`GET /v1/settings` returns `{allowHtml}`. Only the owner changes it, with `PUT /v1/settings`.

## Usage counts

Each inbox counts how much it was used per UTC day, and sends one report for each finished day. The counts live in the inbox's own storage, under the `telemetry` key of `meta`. The keys of the distinct counts, such as agent names and token ids, stay there too. The report gives how many there were. The report has fixed fields, and every value is a number, a fixed word, a UUID, a version, a day or a 16-digit hex id:

```json
{
  "schema": 1,
  "source": "laptop",
  "installId": "0b5e8c1e-6f0a-4d43-9a7e-3f1d2c4b5a69",
  "invite": "",
  "version": "0.1.0",
  "day": "2026-10-28",
  "counts": { "cards": 3, "answers": 2, "pairings": 0, "pages": 1, "agents": 2, "instances": 2, "tokens": 1 }
}
```

- `cards` counts new cards from agents. A revision of a card doesn't count.
- `answers` counts answers saved, and `pairings` counts pairing requests.
- `pages`, `agents`, `instances` and `tokens` count distinct page ids, agent names, agent processes and tokens seen that day, up to 1,000 each.
- `installId` is a random UUID per inbox. `invite` is empty on a laptop. A hosted inbox reports the first 16 hex digits of the SHA-256 of the invite code that created it.

Laptop and hosted inboxes treat the counts differently:

- **A laptop inbox** starts with the counts off, and doesn't count or send until the person turns them on. Its report has a random install id and an empty `invite`. No field says who the person is or which machine sent it. `your-attention serve` and `your-attention start`, run in a terminal, show the offer once and ask `Send anonymous usage counts? [y/N]`. Any answer but yes keeps them off. Without a terminal, such as under launchd or systemd, the inbox page shows the offer until the person picks "Turn usage counts on" or "Keep them off". `your-attention telemetry status` shows it too.
- **A hosted inbox** always counts and sends, with its invite id, and has no off switch. The landing page says so above the button that creates the inbox, and the inbox page says so once, until the person picks "OK". `PUT /v1/telemetry {enabled: false}` answers 400. A single-mode deployment doesn't count or send.

Turning the counts off on a laptop deletes the counts of today and every day not yet sent, and the inbox doesn't count while they are off. An inbox keeps unsent days for a week at most, and a day without activity doesn't produce a report.

`GET /v1/telemetry` returns `{enabled, notified, alwaysOn, notice, blocked, source, destination, installId, invite, next}` to the owner, where `next` is the report for today so far. `notice` is true while the page must show the offer or the always-on notice. `alwaysOn` is true on the hosted service. `blocked` is null, or says why this build doesn't send. `PUT /v1/telemetry {enabled?, notified?, resetId?}` changes the setting, and setting `enabled` also records that the person read the notice. `resetId: true` picks a new install id. Other tokens get 403, and a build without usage counts answers 404.

The laptop build tries to send the finished days 30 seconds after it starts and then every hour. It posts each report to `https://telemetry.your-attention.workers.dev/v1/report`, or to `YOUR_ATTENTION_TELEMETRY_URL`. It keeps a day the collector didn't take because of a network error, a 5xx or a 429, and forgets it after any other answer. With `DO_NOT_TRACK=1` or `YOUR_ATTENTION_TELEMETRY=off`, the laptop build doesn't send, whatever the inbox says. `YOUR_ATTENTION_TELEMETRY_DEBUG=1` prints each report to stderr in place of sending it.

The collector is `src/cloudflare/collector.ts`, a Worker apart from the inbox Worker, configured in `wrangler.telemetry.jsonc`. `POST /v1/report` takes a body of at most 2 KB and checks it against the fields above. A good report gets 204. A report that doesn't match gets 400, and so does a report with an `invite`, since only a laptop posts there. A larger body gets 413, and an address past 10 reports a minute gets 429. It uses the address as the rate limiter's key and never stores it.

A hosted inbox writes its own reports to the `TELEMETRY` binding at its next request or alarm after the day ends, whether or not the page has shown the notice yet. A single-mode deployment doesn't write any. Hosted inboxes and the collector write one data point per report to the `your_attention_usage` Analytics Engine dataset:

| Column | Value |
| --- | --- |
| `index1` | the invite id, or `laptop` |
| `blob1` to `blob5` | source, version, day, install id, invite id |
| `double1` to `double7` | cards, answers, pairings, pages, agents, instances, tokens |

`your-attention telemetry report [--days 30] [--invites FILE]` reads the dataset with the Analytics Engine SQL API, with `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` that has Account Analytics Read. It prints one line per invite id with the inboxes, active days, sums and the peak distinct counts in one inbox and day. It flags an invite with more than 30 agent processes, 10 tokens or 20 pairing requests in one inbox and day, which suggests a shared or leaked invite code or token. Each line of the invites file is a code, then an optional label. The command hashes each code the same way, and prints the label in place of the id.

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

`GET /v1/state` returns `{cards, answers, presence, states, priorities, levels, settings, guidance}`. `cards` has one summary for each card except the cleared ones, enough for the queue, the levels, presence and the answer states:

- `id`, `agent`, `kind`, `title`, `priority`, `status`, `rating`, `from`, `follows`, `followedBy`, `deliver`, `version`, `createdAt`, `updatedAt` and `expiresAt`, as on the card.
- `tags`, at most 10, with each key and value cut to 100 characters. `origin` keeps `name` and `harness`.
- `closed`, with its outcome cut to 300 characters, and `triage` with its `state` only.
- `replyAt`, the time of the newest agent reply, and `unseenReplies` while one waits to be seen.
- `links`, the ids that the text links with `[[card-id]]`, at most 20, and `preview`, the first 300 characters of the text.
- `rev`, which changes with every change to the card or its answer.

`answers` has `{version, savedAt, deliveredAt, readAt, forcedAt}` for each answered card. The values and the comment come with the card. `GET /v1/cards/<id>` returns `{card, answer, state, rev}`, where `card` is the whole card and `rev` is its summary's. The page and the terminal client fetch it when a card opens, and fetch the card after it in queue order, and the card it follows, ahead of time. So moving to the next card draws at once. A copy whose `rev` differs from the summary's is out of date, and the client fetches it again, while it keeps the old copy on screen.

The inbox writes each summary into a collection of its own, each time the card or its answer changes, and deletes it when the card is cleared. So `GET /v1/state` reads small rows of the shown cards only. An inbox stored before summaries writes them once when it starts. Both builds send summaries, so the page and the terminal client use one protocol.

An inbox built with `shownCardLimit` shows at most that many cards. A new card past the limit answers 507 until the person clears answered or closed cards, and so does a pairing request, whose card would pass it. A revision of a shown card still goes in. The Cloudflare build sets the limit from `SHOWN_CARDS_LIMIT`, 500 in `wrangler.jsonc`, so its state fits 10 ms of CPU time. The laptop inbox has no CPU limit and shows every card. `GET /v1/events` sends `change {card}`, `presence {agent, online}`, and `code` when the page source changed. A page refetches the state on each `change`. On `code`, a hidden page reloads at once. A page someone looks at reloads once nothing has happened on it for 3 seconds and no field has focus, so it never takes a field away while the person types. Drafts and the scroll position come back after the reload. When the agent revises a card while the person answers it, the form stays in place with its text and focus, and shows the new version. A pick records the option's id and label, so a revision that drops or relabels the picked option drops that pick.

The tab icon is the ✋ emoji, `web/favicon.svg`. While a card waits for you, the page switches it to `web/favicon-waiting.svg`, which adds a red dot.

`your-attention open`, `open --link` and `login-url` get a sign-in code from `POST /v1/sign-in-codes` with the owner token of the inbox this machine runs. On a machine that runs none, they use the inbox it paired with as owner. `your-attention pair --role owner` saves that pairing in `owner.json`, and an agent pairing stays in `client.json`, so an owner pairing never replaces the agents' token. An owner pairing that an older version saved in `client.json` still works. On a machine paired only as an agent, the inbox answers 403. The command, and `your-attention tui`, then say to pair as owner with `your-attention pair <url> --role owner`. The command says no inbox runs on the machine only when it runs none and paired with none. A cloud inbox's sign-in page says that its address doesn't sign a browser in by itself, and names the commands that do.

The phone button, left of the GitHub mark, opens a QR code that opens the inbox on a phone, signed in. The page gets a sign-in code from `POST /v1/sign-in-codes`, which only the owner may call, and the QR code encodes the page's own address with `#signin=<code>`. The phone sends the code to `POST /v1/login {code}`, which gives it its own owner token, named for the time it signed in, so you can revoke the phone alone. A code works once, for five minutes, and an owner may hold five at a time. The dialog gets a fresh code 30 seconds before the current one expires. The owner token never goes in the QR code. When the page runs on `localhost` or `127.0.0.1`, the dialog reads `GET /v1/addresses`, which only the owner may call. Its answer lists the laptop's `.local` name, then its IPv6 and IPv4 addresses on the local network, such as `http://laptop.local:4815`, when it listens on every interface. It leaves out tunnels, VPNs and container bridges. `serve` listens on `::` by default, which takes IPv4 and IPv6, and on `0.0.0.0` on a machine without IPv6. A VPN that sends the network's IPv4 into its tunnel often leaves IPv6 alone, so a phone still opens the inbox over IPv6. The QR code then encodes the first of them, and the dialog shows the next one in case the phone cannot resolve `.local` names. An inbox that listens on `127.0.0.1` only lists none, and the dialog says a phone cannot open it. `qrcode-generator` draws the code, served at `vendor/qrcode.mjs`.

On a screen 760 pixels wide or less, the page puts the queue below the card, and a button above the card says how many cards wait and scrolls to the queue. The bar scrolls away with the page. A connected inbox shows as a dot, and a lost connection keeps its words. Fields use 16-pixel text, so iOS does not zoom into them.

## The terminal client

`your-attention tui` is a second front-end, for a terminal. It calls the page's routes, with an owner token in the `Authorization` header: `GET /v1/state`, `GET /v1/cards/<id>`, `POST /v1/cards/<id>/answer`, `/seen` (the person read the agent's replies), `/open` (herdr focuses the card's own pane, and a hosted inbox answers 501), `/release`, `/force`, `POST /v1/archive`, `POST /v1/focus` for herdr session links, and `GET /v1/attachments/<id>` for the text of Markdown, CSV, JSON and plain files. It follows `/v1/ws?page=1&viewer=<page id>`, with `GET /v1/events` when the socket never opens, and refetches the state on each `change`. Its page id starts with `tui-`, and it reports `POST /v1/person/<page id>` as a page does. The terminal's focus reports set `visible`. When the inbox answers 423 with `locked`, the client asks for the PIN in the terminal, derives its key with the salt and iterations of `GET /v1/pin`, and sends `POST /v1/unlock {key}`. It keeps the unlock token in memory for the life of the process, and sends it in `x-your-attention-unlock` and in `unlock=` on the page socket. It never stores or prints the PIN, and a socket closed with 4423 makes it ask again.

The client builds each card's OpenUI Lang with `cardSource` from `web/answers.js`, the page's own code, and parses it with `@openuidev/lang-core` and the page's component list in `src/adapters/openui-library.ts`. The inbox checks bodies against that same list. Each field keeps its value as the page's renderer stores it, in `{form: {field: {value}}}`, so `formValues` and `answerValues` from `web/answers.js` give the same answer for the same picks. Secret, broadcast and HTML cards get forms of their own, with the page's buttons. A secret card seals its value with `web/sealed.js` in the client's process. The client queue comes from `web/queue.js`, also shared with the page, so the sections, Skip for now and the card after an answer follow the page's order.

The client never runs an HTML card's scripts. For an HTML card, a chart or another component it can't draw, it shows a line with the card's address on the page, `<inbox url>/#card=<id>`. It drops escape sequences, other control characters and bidirectional overrides from every card field before it writes them to the terminal.

## Search

`GET /v1/search?q=<words>` matches each word as a prefix, over card text and answer comments. The laptop build uses SQLite FTS5.

## Discovery

On a LAN the inbox advertises `_cardinbox._tcp` over mDNS, with the TXT record `v=1`, `id=<inbox id>`, `pair=/v1/pair`. `your-attention serve --no-mdns` turns the advertisement off.

## Starting and stopping the laptop build

`your-attention serve` runs the inbox in the foreground. `your-attention start` runs `serve` in the background with the same options, and returns once the inbox answers. Its output goes to `serve.log`. The inbox writes its address to `server.json` and removes the file when it closes.

`your-attention stop` sends `POST /v1/shutdown` with the owner token, and waits until the inbox no longer answers. Other tokens get 403. When a launchd or systemd service runs the inbox, `stop` stops the service, because the service manager restarts an inbox that exits. The Cloudflare build has no shutdown route.

## The Cloudflare build

`src/cloudflare/worker.ts` runs the same core on Workers. It doesn't bundle mermaid or the OpenUI parser, since the clients check diagrams and bodies, as [Checks on the client](#checks-on-the-client) describes. Each inbox is one Durable Object, `InboxObject`, which keeps its state in the object's SQLite database, with FTS5 for search, and file bytes in R2 under the object's id. The object hibernates when idle:

- Each agent WebSocket keeps its agent id and token in the socket attachment, so the object reconnects every socket to the inbox when it wakes, and presence stays as it was.
- The object answers `{"type":"ping"}` with `{"type":"pong"}` through the runtime's auto-response, which does not wake it. An alarm every 30 seconds closes a socket whose last pong is older than 60 seconds.
- The object sets its alarm for the next moment `sweep()` has work, from `nextDeadline()`, and for no other time.

With `MODE` set to `single`, the Worker serves one inbox, whose owner token is the `OWNER_TOKEN` secret. With `MODE` set to `hosted`, it serves many:

- `POST /new {invite, pin?, neverAsk?}` takes one use of an invite code and returns the address of a new inbox and its owner sign-in link. `pin` is `{key, salt, iterations}`, which the landing page derives with `/pin-key.js`, as for `PUT /v1/pin`. With a `pin`, the inbox starts with that PIN, and the answer adds `unlock`, which the landing page puts in the tab's `sessionStorage` before it opens the inbox. KV keeps `invite:<code>` with the number of uses the operator allows, and a registry Durable Object counts the uses taken, one request at a time.
- Each inbox is at `/i/<id>/`. The person bookmarks the address and keeps it private. The address signs a browser in, and the PIN, when there is one, unlocks each tab.
- The operator manages invites with `wrangler kv key put invite:<code> <uses> --binding INVITES --remote`. Codes need 20 characters or more, such as the 128 random bits of `openssl rand -hex 16`, and the Worker refuses a shorter one before any lookup.
- An address is 20 random hex digits and 12 hex digits of an HMAC over them, keyed by the `INBOX_ID_SECRET` secret. The Worker checks the HMAC, so a guessed address costs no KV read and reaches no Durable Object. Changing the secret makes every address invalid.
- Each inbox's sign-in cookie has the path `/i/<id>/`, so signing in to one inbox leaves another one's cookie alone.

The Worker counts each request before it reaches a Durable Object, with two Workers rate limiting bindings, and answers 429 past them. `LIMITER` counts signed-in calls per inbox and client address, 300 a minute. `ANON_LIMITER` counts calls without a token per client address, 100 a minute, including `POST /new`. So a stranger without a token can't use up the owner's budget. Both limits are approximate, since Cloudflare counts per location. The hard limits are the budgets each inbox applies itself:

- 100 MB of files over the inbox's life, from `UPLOAD_LIMIT_BYTES`.
- 20 MB of database storage, from `STORAGE_LIMIT_BYTES`. The Durable Object adds up its rows once, then adds or subtracts the size of each write.
- 2,000 file downloads a day for each client, from `ATTACHMENT_READS_PER_DAY`.
- 500 cards on show, from `SHOWN_CARDS_LIMIT`.

R2 deletes each file 30 days after its upload, by the lifecycle rule in `cloudflare/main.tf`.

An open request keeps a Durable Object awake and billed, so the Cloudflare build answers `GET /v1/events`, `/v1/stream` and `/v1/poll` with 410. Agents and pages use hibernating WebSockets, whose pings get their answer from the runtime without waking the object. Each inbox keeps at most 64 sockets. A socket that has not signed in 10 seconds after it opened closes at the next alarm, and a socket that sends more than 120 frames in a minute closes with 4429. In single mode, each Worker isolate gives the owner token to the inbox on its first request only.

`npm run cloudflare:check` bundles the Worker with a dry-run deploy, and `npm run test:cloudflare` runs the hosted build on `wrangler dev` with local Durable Objects, R2 and KV. The `deploy-cloudflare` workflow deploys it when someone runs it from the Actions tab.
