# Design principles

Each principle states what Your Attention does, with its reason below it.

Every change to this repo is checked against these principles. A change that breaks one either changes the code or amends the principle in the same pull request.

## Card format

### Each card body is free-form widgets that fit its question

The agent picks the widgets that fit the question. A code review gets a diff, a comparison gets a table, numbers get a chart, and a choice gets option cards or a slider. Cards are generative UI written in OpenUI Lang, and by default the renderer accepts only widgets from the library. If you turn on the option, an agent can also send its own scripts and raw HTML. These run in a sandboxed frame that cannot read the inbox or your other cards. A card can also come with up to 10 files, such as images or PDF documents. The inbox shows each file with a renderer for its type.

The right widget makes a card fast to answer, and some cards need more than the library offers, under a sandbox you choose to allow.

### Agents keep card templates and revise them from your feedback

An agent saves a card format that works as a template. When you comment on a format, the agent writes a new template version and records your feedback with it. Agents manage templates first. Browsing them in the inbox is possible, but it comes later.

Cards get easier to answer over time, and agents do that work for you.

### Open pages update themselves

When a card, a template or the page code changes, the inbox pushes the change to every open page. The update keeps the drafts you have typed.

You should never have to reload.

### A follow-up is a new card, linked both ways to the one before

When an agent revises a card or needs you again, it sends a new card. The new card links back to the card it follows, and the old card links forward to its follow-up, so you can walk the chain in both directions. The card just before appears collapsed below the new one, with your answer, in the layout you answered it in.

Cards stay short-lived, and the links let you trace a decision without a chat thread.

### A new card never replaces the one you are reading

The card you have open remains on screen until you move on from it, by answering, skipping, picking another card, or closing the page. A new card joins the queue in its priority slot, above your card if it ranks higher, with a mark that it is new.

A card that changes under you loses your place and your train of thought.

### Cards link to other cards in their text

A card can link to one or many other cards inside its question, as hypertext. A link always reads as the linked card full title, never a bare id. Hovering a link shows a preview of the card, or at least its title, and a click opens it in place. The inbox shows which cards link to the one you have open, and the follow-up chain is one kind of link among these.

Decisions depend on each other, and a link you can read and preview costs less attention than one you must open.

### Agents edit a card with small patches

To change a card, an agent sends edits against the card source, the way a coding agent edits a file with its patch tool: replace this exact text with that one. The card is a virtual file, so agents can reuse the editing habits they already have. A long card, such as a design spec, then costs only the tokens of the change. The inbox keeps each version, and you see what changed.

Resending a large card for each small edit wastes tokens and hides what changed.

### Secrets go to the agent sealed, and never into the conversation

A secret card requests one value, such as an API key. The card contains a public key. The matching private key stays in the memory of the session that posted the card. Your browser encrypts the value with it before it leaves the page, so the inbox stores ciphertext only. The agent opens the value into a file that only your user account can read, and the model gets the path of the file. The value itself never appears in a transcript or a log.

Agents need keys to finish their work, and a key typed into a chat remains in its transcript after the session ends.

## Card quality

### Triage checks cards before you see them

Triage is a pluggable extension that checks each card for a goal, the options that the agent weighed, evidence, and a recommendation, and sends back a card that lacks them. The default approver signs in with OpenRouter OAuth and bills your own OpenRouter account, so setup takes one click. Instead, it can use one of your coding subscriptions and run Codex, Claude Code, pi, or Cursor in print mode. Triage runs as its own service, such as a systemd or launchd unit, that listens for new cards. When it is offline, cards go straight to you, and when it reconnects it screens the cards still waiting.

Your attention is the scarce input, and onboarding must be easy. Triage must never stand between you and a card when it is down.

### Each card includes a recommendation

The agent says what it would do and why. You accept it as it is, or say what to change.

Reacting to a proposal is faster than writing an answer from a blank page.

### Agents choose the answer options, guided by you

The agent picks the answer options for each card from your guidance. Choices such as yes, yes and, no but, and no are an example, never a default the agent copies. The guidance describes what a good set of options does for you, so agents shape options to each question. Every option and the comment are optional, and you can send an empty answer. The agent gets whatever you sent as structured data.

Fixed buttons fit few questions, and guidance that is too precise turns into fixed buttons again.

### Cards show a priority and come one at a time

The inbox shows one card at a time, highest priority first. It comes with default priority levels and definitions, such as decide now, decide soon and can wait. Agents can rename the levels and change their definitions. A level can also be a rule written as a JavaScript expression. The inbox evaluates it in a sandbox, using card properties such as blocked work and wait time, the agent rating, and tags.

A long list is hard to work through, and what counts as urgent differs by project.

### Past answers are searchable, so agents ask once

The inbox keeps each card and its answer, and search over them returns in well under a second. An agent searches past answers before it posts, and triage sends back a card that an earlier answer already covers. Each inbox indexes its own cards in its own SQLite store with full-text search: one file on a laptop, and the SQLite storage of its Durable Object in the cloud. Thousands of cards stay a small index. Search by meaning can be added as an extension.

The same question from ten sessions should cost you one answer, and a slow search would push agents to ask again.

### Card guidance is shared, and you approve each broadcast

The inbox keeps the guidance agents follow when they write cards: answer options, tone, what context to include. You ask an agent to change it. Agents fetch the current guidance, and a broadcast sends a change to agents that have no open card. Each broadcast first appears to you as a system card. There you pick the agents that receive it, and all agents are picked by default. It goes out only when you approve it.

Guidance should change in one place, and nothing should reach all your agents without your approval.

### Cards group by any property agents provide

The queue has no grouping by default. The inbox offers grouping by priority and by agent first. You can also group by any property that agents attach to their cards, such as topic or tag. The set of groupings follows the properties that cards actually carry, and nobody has to declare them in advance.

With 100 sessions, one long queue hides which work a set of cards belongs to.

## Delivery

### Answer delivery depends on the kind of card

A card made from a harness blocker, such as an approval prompt, blocks the agent until you answer. A card the agent sends on its own gets an asynchronous answer, inside the current turn or as a new turn. You pick how to deliver it: steer the current turn, queue it as a follow-up, force-send it to interrupt, or let your default apply. Your preference sets the default. The system default is to steer, or to start a new turn when the agent is idle.

Most cards are voluntary, so blocking on them would stall the agent for no reason.

### You see how far your answer got

Each answer shows its delivery state: stored, delivered to the harness, or read by the model. An answer queued behind a running tool call shows as delivered but unread. Until the model reads it, the answer waits in an outbox where you can force-send it.

You need to know whether the model has your answer yet, and a way to push it through.

### Each card shows if its agent is listening, busy or offline

The card shows one of three states, updated in near real time: listening, busy (connected but working, with unread answers), or offline. You see the state before you start to write. For an offline agent, the card says what will happen to your answer: delivered when the session resumes, or kept in the dead-letter queue.

A fixed number of seconds cannot be guaranteed.

### An answer to an offline agent is kept, and agents can find it

If the agent goes offline, the inbox stores your answer. It delivers the answer when the session resumes, or to a successor agent you pick. An unclaimed answer goes to a dead-letter queue, which agents can query and claim.

Agents crash and sessions end. Your effort should outlast them, and a new session should be able to pick up what an old one missed.

### Each card has one clear state

A card is in one state at a time, shown on the card and in the list. The inbox starts with states such as in triage, open, answered, delivered, read, expired and orphaned. You can ask an agent to add a state, and agents can move their own cards between states.

Your workflow will need states nobody listed here, and the agent that posted a card has the facts about where it stands.

### An agent can retract its card or answer it itself

When an agent no longer needs an answer, it retracts the card or closes it with its own answer and a one-line outcome. The card changes state in the inbox at once, and the outcome stays on the card. You can still reply to a closed card, and the agent receives your reply. An answer from an agent is always marked as the agent's, and it is never shown as yours.

Agents often find the answer on their own, and you must always see who answered.

### Cards change in front of you, with a trace

When a card changes or closes while you are looking at it, you see what happened and can get back to what was there. The presentation of a change is a design choice that evolves with your feedback, outside the principle.

A card that changes without a trace confuses you, and the presentation should be free to change.

### Answered cards go to an outbox, then to sent

When you answer a card, it leaves the queue and goes to the outbox. It moves to the sent list, newest first, once the model has read your answer. You can open a card in either list to read or change your answer.

The top of the queue is for what needs you next, and the outbox shows what has not gone through yet.

### Most cards are short-lived requests, and the conversation stays in the session

Most cards ask for one thing and goes away once it is answered. It is never a chat. When an agent needs you again, it sends a new card, and it puts any explanation in the card text. A longer conversation happens in the session, one click away through the card origin. The inbox also handles long cards, such as a rich design spec.

Short cards stay quick to answer. The inbox is flexible, but it does not replace documents or artifacts.

## Extensions

### The core is small, and features are extensions

The core handles cards, answers, presence, delivery and templates. Triage, notifications, search, priority scoring and harness integrations are extensions, and the core works when you install none of them. The inbox comes with a built-in web interface, and any other front-end can replace it, such as a native mobile app or a desktop app. A device with a screen and buttons can be a front-end too.

A small core runs anywhere, and the front-end is one client of the protocol among others.

### Extensions attach at named hook points, in process or out

Each hook has one contract, whatever the deployment. The extension can be bundled into the build or run as a sidecar on localhost. It can also be an external service over HTTPS or WebSocket. Adding or moving an extension changes configuration, never the core. Each hook declares what a remote extension may do, which can be less than an in-process one. Extensions use their own message schema, separate from the messages agents and cards exchange.

The triage filter may run in process on a laptop and as a separate service in the cloud. Remote code deserves fewer powers, and the extension contract should change without touching the agent protocol.

### Each hook declares its extension failure policy

A hook has a timeout and a declared policy: fail-open passes the card on, fail-closed holds it. The card shows the extension that stopped it, with the reason.

A slow or broken triage model must not freeze your inbox, or pass poor cards to you unless you chose that.

## Integration

### Self-hosted by default, from a laptop to the edge

The inbox runs as one small process on a laptop, or as a Worker with Durable Objects. Card content stays in the deployment you choose. A public hosted service comes later, on the same code.

Cards contain code, plans and secrets from your sessions, and self-hosting comes before any public service.

### A hosted inbox works without an account and costs almost nothing to run

On the hosted service, an inbox is created without a login, and its unguessable URL is the key to it: you bookmark it, and agents pair to it. Each inbox is one Durable Object that hibernates when idle, so an inbox nobody is using costs only its storage.

No sign-up keeps onboarding to one step, and near-zero idle cost makes a free public service possible.

### Usage counts are anonymous and yours to turn on, except on the hosted service

Once a day, an inbox can send counts of how much it was used. It counts new cards, answers, pairing requests and page opens, and how many agents, agent processes and tokens connected. Card text, answers, agent names, paths, host names and inbox addresses stay in the inbox.

- A laptop inbox sends counts only after you turn them on. Its reports have a random install id, and nothing that says who you are.
- A hosted inbox always sends counts, with an id made from its invite code, and says so when you create it and when you first open it.

The maintainers need to know the product is used, and the hosted service needs to spot a leaked invite code or token. On your own machine, the choice is yours.

## Runs anywhere

### The core uses web standards only

The core uses fetch Request and Response, WebSocket, Web Crypto and JSON. The same core code runs on Node, Bun and Deno on a laptop, on Cloudflare Workers with Durable Objects, in a Chrome extension, and in a standalone web page. Web Crypto makes pairing tokens and signs each call that the core sends to an extension.

Web standards are the API that all these hosts share. A browser page can host the inbox for agents that reach it through an extension or a relay, since a page cannot accept connections.

### All state is in storage, and memory is a cache

The inbox writes every card, answer and connection to disk, or to Durable Object storage, before it reports success. It does not keep anything important only in memory. So when a laptop crashes or a Durable Object goes to sleep, the inbox resumes exactly where it was. Timeouts use the platform alarm, which a restart keeps, never a timer inside the process.

A laptop process can crash and a Durable Object can hibernate. Both must resume with no lost card.

### Each inbox has one writer

All changes to one inbox go through one place, one at a time. On a laptop that place is one process, and in the cloud it is one Durable Object. Answers saved at the same moment are applied in order, so they cannot overwrite each other, and the code does not need locks.

This is how Durable Objects work, and one process on a laptop works the same way. Code that assumes many writers would need locks on both.

### Presence comes from connections, and it survives hibernation

Each agent connection stores its agent id and last-seen time in the socket attachment and in storage, so a hibernated inbox still has the list of connected agents. When a connection misses its heartbeats, the inbox marks the agent offline in near real time.

Hibernation clears memory while the sockets remain open. Presence must not depend on memory.

### Platform details sit behind small adapter interfaces

Storage, sockets, alarms, discovery, identity and the Mermaid diagram check are adapters. A build too small to run a check, such as the hosted Worker with its 10 ms of CPU time a request, leaves it to the posting client and the page. The laptop build uses SQLite, a WebSocket server and mDNS. The Cloudflare build uses Durable Object storage, hibernatable WebSockets and alarms.

Adding a platform means writing adapters, and nobody changes the core.

### One documented message model, with pluggable encodings

Agents, pages and extensions exchange the same versioned messages. The encoding and the transport are plugins: JSON over WebSocket is the default, with server-sent events and long-poll for clients that cannot keep a socket. A binary encoding such as gRPC with protobuf can be added as a plugin, with no change to the core.

One message model keeps every client compatible, and pluggable encodings let fast or constrained clients pick what fits.

### On a local network, the inbox advertises itself

The inbox advertises its address on a LAN with DNS-SD over mDNS, the protocol that Bonjour and Avahi use, under a service type such as _cardinbox._tcp. Its TXT record contains the protocol version and a pairing hint. Advertising is on by default, because a client cannot connect until it pairs, and you can turn it off. A cloud deployment uses a URL instead.

Pairing makes the announcement safe: it tells the network only that an inbox exists. Agents on your machines then find it without a URL.

### Every client proves who it is, even on a LAN

Discovery only tells a client where the inbox is. A new agent or device pairs once. Its request appears to you as a system card with a code, and after you confirm it the client gets its own token. You can revoke each token.

Anyone on the network can see an mDNS announcement, so finding the inbox must not grant access to it.

### Agents connect to the inbox from wherever they run

Agents run in many places: your shell, containers, cloud sandboxes, CI, and remote machines behind NAT. Agents always dial out to the inbox, so none of them needs an open port. The inbox can also dial out to a remote server over HTTPS or SSH and offer itself there, and a bridge on a machine can offer the inbox to that machine locally or over mDNS. Each agent receives updates over a WebSocket, server-sent events, or long-poll, whichever its environment allows.

Agents run in many places, and the inbox should come to them when they cannot come to it.

### The protocol and card lifecycle are a specification first, and code second

The messages, card states and delivery rules are written down as a specification, with a conformance test suite. The reference inbox runs on Linux, macOS and Windows. A separate small build, written in Rust or C, can run a client or a minimal inbox on a microcontroller such as an ESP32.

An ESP32 cannot run a JavaScript runtime, so the specification, not one codebase, is what keeps each build compatible.

### Many links to one inbox act as a mesh

An inbox has one stable identity across all its links, whether direct, relayed, tunnelled over SSH, or offered by a bridge. Each message has a unique id, so a message that arrives over two links is delivered once. The inbox and each bridge send over the best working link, and switch when it fails.

Several links make the inbox reachable, but they must never show you a card twice or lose an answer.

## Where cards go

### One inbox for all agents

Cards from all sessions, harnesses and machines go to one inbox. You never open a session to find its question.

You run about 100 sessions. A view per session does not work at that count.

### Each card shows where it came from, and one click takes you there

A card shows the session name and id, the harness, and where the session runs. That place is a host name, cloud or local, plus the tmux, cmux or herdr pane. Clicking the origin opens that session, wherever it runs. The origin and the link are optional. An agent that cannot be linked still posts cards, and its cards show the facts it has.

Sometimes you need the session itself, and some agents run where no link can go.

