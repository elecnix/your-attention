# Your Attention

One inbox for the questions all your coding agents ask you. An agent posts a card and keeps working. You answer in one place, and the answer goes back to that session within a second.

![The inbox: a queue by priority on the left, one card open on the right](docs/screenshot.png)

## Why it helps

With 100 sessions open, a question waits in whichever terminal asked it, and you find it late or never. Your Attention puts every question on one queue, sorted by priority, one card at a time. Each card shows whether its agent is listening, busy or offline, and where your answer is: stored, delivered, or read by the model. An answer to an offline agent waits until its session resumes.

Claude Code and pi post cards through tools, and herdr turns any blocked agent into a card. A secret card requests a key: your browser encrypts it for that session, and the model sees the path of a private file instead of the value. The inbox runs on your laptop and advertises itself over mDNS. Each new client pairs with a code you confirm.

[PRINCIPLES.md](PRINCIPLES.md) states the design and [SPEC.md](SPEC.md) the protocol.

## Install

These steps are for a coding agent to run. It needs Node 22.18 or later.

```sh
git clone https://github.com/elecnix/your-attention ~/Source/your-attention
cd ~/Source/your-attention && npm ci && npm link
your-attention serve &          # keep it running, for example as a launchd or systemd unit
your-attention open             # opens the inbox page, signed in
```

Claude Code: add the channel, then start sessions with it and confirm the development-channel warning.

```sh
claude mcp add -s user your-attention -- your-attention claude-channel
claude --dangerously-load-development-channels=server:your-attention
```

To show `AskUserQuestion` questions as cards too, add two hooks to `~/.claude/settings.json`. Answer in either place. Your terminal answer closes the card, and a card answer goes to the session. In herdr, the terminal dialog closes too.

```json
{ "hooks": {
  "PreToolUse":  [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "your-attention claude-hook ask-pre", "timeout": 10 }] }],
  "PostToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "your-attention claude-hook ask-post", "timeout": 10 }] }]
} }
```

pi:

```sh
pi install git:github.com/elecnix/your-attention
```

herdr, for a card per blocked agent of any harness:

```sh
your-attention herdr-blocked &
```

Triage checks each card before you see it, and sends back a card that lacks a goal, options, evidence or a recommendation. It bills your own OpenRouter account, or runs a coding harness in print mode:

```sh
your-attention triage login                         # once, for OpenRouter
your-attention service triage --write               # a launchd or systemd unit
your-attention triage --judge-cmd "claude -p"       # or a harness instead
```

Agents in containers, CI or other machines connect through a bridge, an SSH tunnel or a relay:

```sh
your-attention bridge --upstream https://inbox.example
your-attention offer ssh build-box
YOUR_ATTENTION_RELAY_KEY=... your-attention serve --relay https://relay.example
```

On Cloudflare, one Durable Object per inbox hibernates when idle. Create a KV namespace, add the secrets that `deploy-cloudflare.yml` lists, then run that workflow from the Actions tab:

```sh
npx wrangler kv namespace create INVITES        # its id goes in the KV_NAMESPACE_ID variable
npx wrangler secret put OWNER_TOKEN             # single mode: your owner token
npx wrangler kv key put invite:<code> 5 --binding INVITES --remote   # hosted mode: an invite with 5 uses
```

Another machine on the LAN finds the inbox and pairs with it. Approve the card that shows the same code.

```sh
your-attention discover
your-attention pair http://<host>:4815
```
