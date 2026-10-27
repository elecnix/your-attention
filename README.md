# Your Attention

One inbox for the questions all your coding agents ask you. An agent posts a card and keeps working. You answer in one place, and the answer goes back to that session within a second.

![The inbox: a queue by priority on the left, one card open on the right](docs/screenshot.png)

## Why it helps

With 100 sessions open, a question waits in whichever terminal asked it, and you find it late or never. Your Attention puts every question on one queue, sorted by priority, one card at a time. Each card shows whether its agent is listening, busy or offline, and where your answer is: stored, delivered, or read by the model. An answer to an offline agent waits until its session resumes.

Claude Code and pi post cards through tools, and herdr turns any blocked agent into a card. The inbox runs on your laptop and advertises itself over mDNS. Each new client pairs with a code you confirm.

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

Another machine on the LAN finds the inbox and pairs with it. Approve the card that shows the same code.

```sh
your-attention discover
your-attention pair http://<host>:4815
```
