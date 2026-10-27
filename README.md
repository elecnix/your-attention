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
your-attention start            # runs the inbox in the background; `service serve --write` makes it a login service
your-attention open             # opens the inbox page, signed in
your-attention stop             # stops it, or its launchd or systemd service
your-attention clear            # clears the cards you answered or that closed; search still finds them
```

Claude Code: add the channel, then start sessions with it and confirm the development-channel warning. Claude Code takes the channel only as a launch flag. To load it in every session, wrap `claude` in a shell function that adds the flag to interactive starts. Keep the `=` form: the flag takes a list, and would take a prompt after it as a second server.

```sh
claude mcp add -s user your-attention -- your-attention claude-channel
claude --dangerously-load-development-channels=server:your-attention
```

To show `AskUserQuestion` questions as cards too, add these hooks to `~/.claude/settings.json`. Answer in either place. Your terminal answer closes the card, and a card answer goes to the session. In herdr, the terminal dialog closes too. When you cancel the dialog, or the session moves on without an answer, `ask-cancel` closes the card.

```json
{ "hooks": {
  "PreToolUse":         [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "your-attention claude-hook ask-pre", "timeout": 10 }] }],
  "PostToolUse":        [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "your-attention claude-hook ask-post", "timeout": 10 }] }],
  "PostToolUseFailure": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "your-attention claude-hook ask-cancel", "timeout": 10 }] }],
  "PermissionDenied":   [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "your-attention claude-hook ask-cancel", "timeout": 10 }] }],
  "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "your-attention claude-hook ask-cancel", "timeout": 10 }] }],
  "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "your-attention claude-hook ask-cancel", "timeout": 10 }] }]
} }
```

pi:

```sh
pi install git:github.com/elecnix/your-attention
```

herdr, for a card per blocked agent of any harness. When the agent shows numbered choices, such as a permission prompt, you can pick one on the card and the sidecar presses it in that agent's pane:

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

On Cloudflare, one Durable Object per inbox hibernates when idle. `cloudflare/main.tf` creates the KV namespace, the R2 bucket and a deploy token that can change Workers only. Its state contains that token, so it stays outside the repo. Put the outputs in the repo's `cloudflare` environment, as `deploy-cloudflare.yml` lists, then run that workflow from the Actions tab:

```sh
export CLOUDFLARE_API_TOKEN=...                  # an account token that can create tokens, KV and R2
terraform -chdir=cloudflare init -backend-config="path=$HOME/.your-attention/cloudflare.tfstate"
terraform -chdir=cloudflare apply -var account_id=<account id>
terraform -chdir=cloudflare output -raw deploy_token | gh secret set CLOUDFLARE_API_TOKEN --env cloudflare
gh variable set KV_NAMESPACE_ID --env cloudflare --body "$(terraform -chdir=cloudflare output -raw kv_namespace_id)"
npx wrangler kv key put invite:<code> 5 --binding INVITES --remote   # hosted mode: an invite with 5 uses
```

Single mode also needs `CLOUDFLARE_ACCOUNT_ID` and an `OWNER_TOKEN` secret in that environment. The account needs R2 enabled once in the dashboard, and a workers.dev subdomain.

Another machine on the LAN finds the inbox and pairs with it. Approve the card that shows the same code.

```sh
your-attention discover
your-attention pair http://<host>:4815
```
