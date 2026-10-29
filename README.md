# Your Attention

One inbox for the questions all your coding agents ask you. An agent posts a card and keeps working. You answer in one place, and the answer goes back to that session within a second.

![The inbox: a queue by priority on the left, one card open on the right](docs/screenshot.png)

## Why it helps

With 100 sessions open, a question waits in whichever terminal asked it, and you find it late or never. Your Attention puts every question on one queue, sorted by priority, one card at a time. Each card shows whether its agent is listening, busy or offline, and where your answer is: stored, delivered, or read by the model. An answer to an offline agent waits until its session resumes.

Claude Code and pi post cards through tools, and herdr turns any blocked agent into a card. A card can draw Mermaid diagrams, such as a flowchart of the choice on the card. The inbox parses each diagram when the agent posts the card and refuses one that doesn't parse, so you never see a broken diagram. A secret card requests a key: your browser encrypts it for that session, and the model sees the path of a private file instead of the value. Each new client pairs with a code you confirm.

[PRINCIPLES.md](PRINCIPLES.md) states the design and [SPEC.md](SPEC.md) the protocol.

## Set it up

These steps take a machine with only a coding harness on it to a full setup. A coding agent can run them for you. Steps marked (optional) add a feature, and you can skip them.

1. [Check what you need](#1-check-what-you-need).
2. [Choose a home for the inbox](#2-choose-a-home-for-the-inbox).
3. [Install the command](#3-install-the-command).
4. [Start or open your inbox](#4-start-or-open-your-inbox).
5. [Connect your agents](#5-connect-your-agents).
6. [Open the inbox on your phone (optional)](#6-open-the-inbox-on-your-phone-optional).

### 1. Check what you need

- **Node 22.18 or later.** The `your-attention` command runs on it. Check with `node --version`.
- **git**, to get the code.
- **A coding harness**, such as Claude Code, pi, or any agent that herdr runs. Your agents post cards from it.
- **A browser.** The inbox is a web page.

### 2. Choose a home for the inbox

The inbox is one server that holds your cards. Pick one place for it:

| Where | What you get | Choose it when |
| -- | -- | -- |
| On your laptop | Unlimited and free, without an account. Agents on the same machine find it on their own. It stops when the laptop sleeps. | You work from one machine. This is the default. |
| Your own Cloudflare inbox | Always on, reachable from any machine and your phone. You deploy it to your own Cloudflare account. | You run agents on several machines, and want to own the deployment. See [Run your own cloud inbox](#run-your-own-cloud-inbox-optional). |
| A hosted inbox | Always on, with no deployment. Someone who runs the service gives you an invite code. Each inbox has [limits](#limits-of-a-cloud-inbox). | Someone already runs the service for you. |

You can change your mind later. Each machine pairs with one inbox at a time.

### 3. Install the command

Agents talk to the inbox through the `your-attention` command, so you install it wherever an agent runs.

```sh
git clone https://github.com/elecnix/your-attention ~/Source/your-attention
cd ~/Source/your-attention && npm ci && npm link
your-attention --help
```

`npm link` puts `your-attention` on your path. To update later, run `git pull && npm ci` in the same folder.

### 4. Start or open your inbox

**On your laptop:**

```sh
your-attention start            # runs the inbox in the background, on port 4815
your-attention open             # opens the inbox page, signed in
your-attention open --link      # prints a one-time sign-in link, for a private window or another browser
```

The inbox keeps its files in `~/.your-attention`. Set `YOUR_ATTENTION_HOME` to move them.

In a terminal, `start` and `serve` offer to set a [PIN](#protect-the-inbox-with-a-pin) while the inbox has none. Type `y` and the PIN twice, `s` to skip until the next start, or `n` to stop asking. A service started at login has no terminal, so it never asks.

To start the inbox when you log in (optional), write a launchd or systemd unit. Without `--write`, the command only prints the unit.

```sh
your-attention service serve --write
```

**On a hosted inbox:**

1. Open the address you got with your invite code. Enter the code and a 4-digit [PIN](#protect-the-inbox-with-a-pin), then select **Create my inbox**. Leave the PIN empty to skip it for now, or tick **Never ask me for a PIN**.
2. The page opens your inbox, signed in. Bookmark that address, and keep it private. You type the PIN in each new tab.
3. Pair each machine that runs agents, as [step 5](#pair-a-machine-with-a-cloud-inbox-or-another-computer) shows.

**On your own Cloudflare inbox:** deploy it first, as [Run your own cloud inbox](#run-your-own-cloud-inbox-optional) shows. Then pair each machine, as step 5 shows.

### 5. Connect your agents

Do the parts for the harnesses you use.

#### Claude Code

Add the channel server once. It gives every session the card tools, and brings your answers into the session as they arrive.

```sh
claude mcp add -s user your-attention -- your-attention claude-channel
```

Claude Code loads a channel only from a launch flag. Start each session with it, and confirm the development-channel warning that Claude Code shows:

```sh
claude --dangerously-load-development-channels=server:your-attention
```

Keep the `=` form: the flag takes a list, and would read a prompt after it as a second server.

**A shell function that adds the flag (optional).** It adds the flag to interactive starts, and leaves subcommands and `--print` alone. Put it in `~/.bashrc` or `~/.zshrc`:

```sh
claude() {
  case "${1:-}" in
    -p|--print|mcp|config|doctor|update|install|plugin|setup-token|migrate-installer|--version|-v|--help|-h) command claude "$@" ;;
    *) command claude --dangerously-load-development-channels=server:your-attention "$@" ;;
  esac
}
```

**Questions from `AskUserQuestion` as cards (optional).** Add these hooks to `~/.claude/settings.json`, next to any hooks you already have. Answer in either place. Your terminal answer closes the card, and a card answer goes to the session. In herdr, the terminal dialog closes too. When you cancel the dialog, or the session moves on without an answer, `ask-cancel` closes the card.

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

#### pi

```sh
pi install git:github.com/elecnix/your-attention
```

#### OpenCode

Write the plugin file once. It gives every session the card tools, and brings each answer into its session as a new message. A message that arrives while the agent works waits for the turn to end.

```sh
your-attention opencode-plugin --write
```

The file goes in `~/.config/opencode/plugin/`, or under `$XDG_CONFIG_HOME` when you set it, and OpenCode loads it at its next start. It loads the plugin from this checkout, so keep the checkout where it is. Run the command without `--write` to see the file first.

#### herdr: a card for each blocked agent (optional)

The sidecar posts a card when any herdr agent waits for you, whatever its harness. When the agent shows numbered choices, such as a permission prompt, you pick one on the card, and the sidecar presses it in that agent's pane. It first checks that the same prompt still waits there.

```sh
your-attention herdr-blocked &
```

#### Pair a machine with a cloud inbox or another computer

A machine whose inbox runs elsewhere pairs once:

1. Run `your-attention pair <inbox address>` on that machine. It prints a six-digit code.
2. A card with a code appears in your inbox. Approve it only when the code matches.
3. The machine saves its token in `~/.your-attention/client.json`, and its agents use that inbox from then on.

For a hosted inbox, the address is the one you bookmarked, such as `https://app.example.workers.dev/i/<inbox id>`. On your network, `your-attention discover` lists the laptop inboxes it finds, with their addresses.

```sh
your-attention discover
your-attention pair http://<host>:4815
```

To pair a front-end that answers cards instead of an agent, add `--role owner`. A machine paired as owner runs the `pin` commands against a hosted inbox, such as `your-attention pin reset` for a forgotten PIN. Its token works without the PIN, so pair a machine as owner only while you sit at it.

#### Check your cards before you see them (optional)

Triage reads each new card and sends back one that lacks a goal, options, evidence or a recommendation. It uses your own OpenRouter account, or runs a coding harness in print mode:

```sh
your-attention triage login                         # once, for OpenRouter
your-attention service triage --write               # a launchd or systemd unit
your-attention triage --judge-cmd "claude -p"       # or a harness instead
```

#### Reach a laptop inbox from containers, CI or other machines (optional)

Agents that can't reach your laptop connect through a bridge, an SSH tunnel or a relay:

```sh
your-attention bridge --upstream https://inbox.example
your-attention offer ssh build-box
YOUR_ATTENTION_RELAY_KEY=... your-attention serve --relay https://relay.example
```

### 6. Open the inbox on your phone (optional)

Select the phone button, left of the GitHub mark, and scan the QR code with the phone camera. The phone opens the inbox, signed in with its own token. The code works once, for five minutes, so keep it to yourself.

A cloud inbox works from anywhere, and a laptop inbox from a phone on the same network. The laptop inbox listens on every network interface, IPv4 and IPv6, by default. Its QR code opens the laptop's `.local` name, such as `http://my-laptop.local:4815`, and the dialog also gives an IP address, for a phone that cannot open `.local` names.

If the phone cannot open the inbox, check for a VPN on the laptop. A VPN that sends your home network's IPv4 traffic into its tunnel breaks every connection from the phone to the laptop over IPv4. The inbox still answers over IPv6, which most home networks and phones use. Otherwise, exclude your home network from the VPN, or use a cloud inbox.

## Day to day

Answer cards on the inbox page. Each answer reaches its agent within a second, or when its session resumes.

```sh
your-attention clear            # clears the cards you answered or that closed; search still finds them
your-attention reset --yes      # removes every card, answer and file; tokens and templates stay
your-attention login-url        # prints a sign-in link that works once, within 5 minutes
your-attention stop             # stops the inbox, or its launchd or systemd service
```

`clear`, `reset`, `login-url` and `stop` act on the inbox this machine runs.

### Answer in a terminal

`your-attention tui` shows the inbox full screen in a terminal, beside your agents in herdr, tmux or any terminal tab. The card list is on the left, in the page's sections and order. The open card is on the right, with its text, the recommendation, its files and its form. Your answer goes to the agent with the same values the page would send.

```sh
your-attention tui              # the inbox on this machine, as its owner
your-attention tui --mono       # no colors
your-attention tui --ascii      # ASCII symbols and borders, for a terminal without Unicode
```

Like the other commands, the client reads `YOUR_ATTENTION_URL` and `YOUR_ATTENTION_TOKEN` first. Without them, it uses a pairing made with `your-attention pair <url> --role owner`, then the inbox this machine runs, with its `owner-token` file. For an inbox with a PIN, the client prompts for the PIN when the token needs it, as a sign-in link's token does. The `owner-token` file and an owner pairing open the inbox without it.

| Key | In the list | In the card |
| -- | -- | -- |
| Up, Down, `j`, `k` | open the card above or below | move between fields, or inside a choice |
| Enter, Right, Tab | move into the card | pick a choice, press a button |
| Space | move into the card | pick a choice or tick a box |
| Tab, Shift+Tab | move into the card | the next or previous field, button or link |
| Esc | | back to the list |
| PgUp, PgDn | ten cards up or down | scroll the card |
| Ctrl+Enter, Ctrl+S | send the answer | send the answer |
| Ctrl+N | skip for now | skip for now |
| `g` | group by nothing, priority, agent or a tag | |
| `C` | clear the answered and closed cards | |
| `o` | open the card in the browser | |
| `?`, `q`, Ctrl+C | help, quit, quit | Ctrl+C quits |

Ctrl+Enter needs a terminal that reports it, such as iTerm2, Ghostty, cmux, kitty or WezTerm, and tmux with `extended-keys` on. Ctrl+S works in every terminal. In a text field, letters type text, and the Ctrl keys still work.

A click opens a card or presses a button. In a form, a click picks a choice, ticks a box or puts the cursor in a text field. The wheel scrolls the pane under the pointer. A click on a herdr session link opens that session in herdr, as on the page. A click on any other link opens it in the browser.

Color is never the only sign. Each state has a symbol of its own: `●` waits for you, `◉` is the card on screen, and `↩` has a new reply. In the Outbox and Sent sections, `○` means the inbox stored your answer, `◑` that the agent got it, `✓` that the model read it, and `×` that the card closed. Each waiting card shows its priority level in words, such as `now` or `soon`, beside the level's color. The card on screen has a marker, `▶`, and inverse video while the list has the keys. Set `NO_COLOR=1` or pass `--mono` for no colors at all, and pass `--ascii`, or set `YOUR_ATTENTION_TUI_ASCII=1`, for symbols such as `*`, `@`, `<` and `>`. `YOUR_ATTENTION_TUI_COLOR` forces a color depth: `mono`, `16`, `256` or `truecolor`.

The client works in iTerm2, cmux, Apple Terminal, tmux and herdr panes, and Linux terminals. From 60 columns it shows the list beside the card, and below that one pane at a time. A card part that a terminal can't draw, such as a chart or an HTML card, shows a line with the card's address on the page. On a laptop, the first frame of an inbox with 200 cards appears about 130 ms after the command starts. `YOUR_ATTENTION_TUI_TRACE=<file>` writes that time and the time of each frame to the file.

## Protect the inbox with a PIN

An answer on a card goes straight into a coding agent's session. Someone who gets the inbox address or a sign-in link, from a bookmark, the browser history or a pasted message, could open the page and answer as you. A 4-digit PIN stops that: the address or link signs a browser in, and each new tab must also type the PIN before it shows a card or takes an answer.

```sh
your-attention pin status       # whether the inbox has a PIN, and any lockout
your-attention pin set          # sets a PIN, typed twice and hidden
your-attention pin reset        # replaces a forgotten PIN without the old one, and lifts a lockout
your-attention pin clear        # removes the PIN
```

The PIN commands act on the inbox this machine runs, with its `owner-token` file, or on the inbox this machine paired with as owner. On the page, the buttons below the card list change the PIN, which needs the current one, and lock the tab.

- Closing the tab locks the inbox again. A tab also locks after 12 hours without a request, and every tab locks when the PIN changes.
- After 5 wrong PINs, the page waits 1 minute before the next try. Each later lockout doubles the wait, up to a day. `your-attention pin reset` lifts the lockout from the computer that runs the inbox.
- The inbox stores a slow salted hash of the PIN. Nobody can read the PIN back, including you.
- Without a PIN, the page offers to set one each time it opens. **Skip** asks again next time, and **Never ask again** stops the offer for that inbox.

The PIN guards the page and every sign-in link. Agents and their tokens, and the `owner-token` file on the laptop, work without it. A PIN does not protect the inbox from someone who can read files on the laptop, or from a person who watches you type it. A 4-digit PIN has 10,000 values, so the wait after wrong tries is what stops a guesser. After about 60 tries in the first day and a half, a guesser gets 5 tries a day.

## Usage counts

A laptop inbox sends nothing unless you turn usage counts on. The first start in a terminal asks once, and the inbox page offers them until you pick. When on, the inbox sends the maintainers one anonymous report a day. It counts cards posted and answered, pairing requests, page opens, and how many agents, agent processes and tokens connected, with a random install id. It never sends card text, answers, agent names, paths, host names, addresses or anything else that says who you are.

```sh
your-attention telemetry status     # on or off, where reports go, and the install id
your-attention telemetry on         # turns anonymous reports on
your-attention telemetry show       # prints the next report
your-attention telemetry off        # turns reports off and deletes the days not yet sent
your-attention telemetry reset-id   # picks a new random install id
```

`DO_NOT_TRACK=1` or `YOUR_ATTENTION_TELEMETRY=off` keeps reports off whatever the setting says, and `YOUR_ATTENTION_TELEMETRY_DEBUG=1` prints each report to stderr in place of sending it.

The hosted service always sends the same counts, with an id made from the invite code that created the inbox, and has no off switch. Its landing page and the inbox page say so. To keep the counts to yourself, run the inbox on your laptop. [SPEC.md](SPEC.md#usage-counts) lists every field.

## Run your own cloud inbox (optional)

The Cloudflare build runs the same inbox on Workers. Each inbox is one Durable Object that sleeps when idle. Choose a mode when you deploy:

- **single** serves one inbox, yours, at the root address.
- **hosted** serves many inboxes. Each person creates one with an invite code you give out.

You need a Cloudflare account with R2 turned on once in the dashboard, a workers.dev subdomain, Terraform, and the GitHub CLI.

1. Create the KV namespace, the R2 bucket, its 30-day expiry rule, and a deploy token that can change Workers only. The state file contains that token, so it stays outside the repo:

   ```sh
   export CLOUDFLARE_API_TOKEN=...                  # an account token that can create tokens, KV and R2
   terraform -chdir=cloudflare init -backend-config="path=$HOME/.your-attention/cloudflare.tfstate"
   terraform -chdir=cloudflare apply -var account_id=<account id>
   ```

2. Put the outputs in the repo's `cloudflare` environment:

   ```sh
   terraform -chdir=cloudflare output -raw deploy_token | gh secret set CLOUDFLARE_API_TOKEN --env cloudflare
   gh variable set KV_NAMESPACE_ID --env cloudflare --body "$(terraform -chdir=cloudflare output -raw kv_namespace_id)"
   gh secret set CLOUDFLARE_ACCOUNT_ID --env cloudflare --body "<account id>"
   ```

3. Add the secret for your mode:

   - Single mode needs `OWNER_TOKEN`, your owner token. It is 12 hex digits, a dot, and 64 hex digits: `echo "$(openssl rand -hex 6).$(openssl rand -hex 32)" | gh secret set OWNER_TOKEN --env cloudflare`. Keep a copy: you sign in with it.
   - Hosted mode needs `INBOX_ID_SECRET`, which signs inbox addresses: `openssl rand -hex 32 | gh secret set INBOX_ID_SECRET --env cloudflare`. Changing it later makes every inbox address invalid.

4. Run the `deploy-cloudflare` workflow from the Actions tab, and pick the mode. The Worker is named `app`, so it answers at `https://app.<subdomain>.workers.dev`.

5. In single mode, open `https://app.<subdomain>.workers.dev/#token=<owner token>`. In hosted mode, add an invite code. Codes need 20 characters or more, and the last number is how many inboxes the code creates:

   ```sh
   npx wrangler kv key put invite:$(openssl rand -hex 16) 5 --binding INVITES --remote
   ```

   That command doesn't print the code. Put it in a variable first if you want to give it out.

In hosted mode, each inbox writes its daily usage counts to the `your_attention_usage` Analytics Engine dataset in your account, with an id made from its invite code. `your-attention telemetry report --invites <file>` lists usage per invite and flags an invite with many clients in one inbox. Each line of the file is a code and a label. It needs `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` with Account Analytics Read.

### Limits of a cloud inbox

The Cloudflare build sets these in `wrangler.jsonc`, so a free account stays within its quotas:

- 100 MB of uploaded files over the inbox's life. Each file counts as at least 64 KB, and the count doesn't go down when a file is deleted.
- 20 MB in the inbox's database. A full inbox takes only deletes, answers and closes until you make room.
- 2,000 file downloads a day for each client.
- 300 requests a minute for each signed-in client address, per inbox, and 100 a minute for each address without a token.
- R2 deletes each file 30 days after its upload. The card stays.
- Pages and agents get their events over WebSockets, so an idle inbox sleeps. The event stream and long-poll routes answer 410.

A laptop inbox has none of these limits.
