# Agent instructions

Your Attention is one inbox where coding agents ask a person questions as cards, and each answer goes back to the agent that asked. Read [PRINCIPLES.md](PRINCIPLES.md) and [SPEC.md](SPEC.md) before you change anything.

## Check every change against the principles

[PRINCIPLES.md](PRINCIPLES.md) is the authority on how the system must work. Check your change against it before you open a pull request. A change that breaks a principle is not ready to merge.

1. Before you write code, find the principles your change touches.
2. If the change would break a principle, stop. Either change the design, or amend the principle in the same pull request and say why in the body.
3. When you build something the SPEC.md table lists as missing, delete its row in the same pull request.

Reviewers, human or automated, check the diff against PRINCIPLES.md and block a change that breaks one. `test/unit/principles.test.ts` checks the principles that a test can read off the source. Add a check there when you find another one.

## Layout

```
src/core/          the protocol: types, the single-writer inbox, the HTTP handler. Web standards only.
src/adapters/      SQLite storage and mDNS discovery for the laptop build
src/node/          the Node HTTP server and the home directory
src/integrations/  Claude Code (MCP channel, AskUserQuestion hooks), pi, herdr
src/client.ts      the client every integration uses
src/cli.ts         the your-attention command
web/               the built-in page, plain JavaScript on the OpenUI browser bundle
test/unit/         fast tests with in-memory storage
test/integration/  a real server, the CLI, the channel over MCP stdio, the pi extension, and mDNS
```

## Rules a reader cannot find in the code

- `src/core/` imports only other files in `src/core/`, so the same code runs on Node, Bun, Deno and Workers. Platform code goes in an adapter.
- Storage calls are synchronous. A method on `Inbox` finishes its change before the next change starts, which is how one inbox has one writer without locks. Never put an `await` between a read and the write that depends on it.
- Node runs the TypeScript sources directly, so write only syntax that Node can erase. Enums, namespaces and parameter properties fail at run time. Import local files with their `.ts` extension and types with `import type`.
- Logs from the Claude Code channel go to stderr, because stdout carries the MCP protocol.
- The herdr integration may send keys only to the pane of its own session. Never send keys to another pane.
- Each user-visible string names the thing it shows. The person may leave any answer field empty.

## Commands

```sh
npm ci
npm run typecheck        # tsgo and tsc-rs, and both must pass
npm test                 # unit, then integration
vale sync && vale *.md   # prose rules, the same ones CI runs
```

Set `YOUR_ATTENTION_SKIP_MDNS=1` to skip the mDNS test on a network that drops multicast.

## Pull requests

CI runs both type checkers, the tests on Linux, macOS and Windows, Vale on the Markdown files, dupdelta for new duplicate code, and gh-pr-body-action on the body. Cite reviews each pull request and reads this file.
