// The pi extension: card tools for the agent, and each answer delivered into
// the session as a user message, steering the current turn or starting a new
// one. The answer is marked read when it reaches the model context.
import os from 'node:os';
import { Type } from 'typebox';
import { Client, describeAnswer, loadConfig } from '../../client.ts';
import type { CloseKind, NewCard, Option } from '../../core/types.ts';
import { cardTools } from '../tools.ts';

// The parts of pi's ExtensionAPI this extension uses.
interface PiContext {
  isIdle(): boolean;
  sessionManager: { getSessionId(): string; getCwd(): string; getSessionName?(): string | undefined };
}
interface ToolResult {
  content: { type: 'text'; text: string }[];
  details: unknown;
}
interface PiApi {
  on(event: 'session_start' | 'session_shutdown', handler: (event: unknown, ctx: PiContext) => void | Promise<void>): void;
  on(event: 'context', handler: (event: { messages: unknown[] }, ctx: PiContext) => void | Promise<void>): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiContext): Promise<ToolResult>;
  }): void;
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
}

const result = (text: string): ToolResult => ({ content: [{ type: 'text', text }], details: undefined });

export default function yourAttention(pi: PiApi): void {
  let inbox: Client | undefined;
  let agent = '';
  let origin: NewCard['origin'];
  let stop: AbortController | undefined;
  // Receipt id -> card id, for answers sent but not yet in the model context.
  const pending = new Map<string, string>();

  pi.on('session_start', (_event, ctx) => {
    const config = loadConfig();
    if (!config) return;
    inbox = new Client(config);
    const session = ctx.sessionManager.getSessionId();
    agent = `pi:${session}`;
    origin = { harness: 'pi', session, name: ctx.sessionManager.getSessionName?.(), host: os.hostname(), cwd: ctx.sessionManager.getCwd(), herdrPane: process.env['HERDR_PANE_ID'] };
    stop?.abort();
    stop = new AbortController();
    const client = inbox;
    void client.stream(agent, (ev) => {
      if (ev.type !== 'answer') return;
      pending.set(ev.id, ev.card.id);
      const text = `[your-attention answer ${ev.id}] The person answered card "${ev.card.title}" (id ${ev.card.id}):\n${describeAnswer(ev.card, ev.answer)}`;
      // Steer by default; start a new turn when the agent is idle.
      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: ev.answer.delivery === 'followUp' ? 'followUp' : 'steer' });
    }, stop.signal);
  });

  pi.on('session_shutdown', () => {
    stop?.abort();
    stop = undefined;
  });

  pi.on('context', (event) => {
    if (!pending.size || !inbox) return;
    const seen = JSON.stringify(event.messages);
    for (const [receipt, card] of pending) {
      if (!seen.includes(receipt)) continue;
      pending.delete(receipt);
      inbox.ack(card).catch(() => {});
    }
  });

  const need = (): Client => {
    if (!inbox) throw new Error('No inbox found. Start one with `your-attention serve`, or pair with `your-attention pair <url>`.');
    return inbox;
  };

  for (const tool of cardTools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name.replace('_', ' '),
      description: tool.description,
      parameters: Type.Unsafe(tool.schema),
      async execute(_id, args) {
        const c = need();
        switch (tool.name) {
          case 'card_post': {
            const card = await c.post({
              id: args['id'] as string | undefined,
              agent,
              title: String(args['title'] ?? ''),
              text: args['text'] as string | undefined,
              recommendation: args['recommendation'] as string | undefined,
              options: (args['options'] as string[] | undefined)?.map((label, i): Option => ({ id: `o${i + 1}`, label })),
              multiple: args['multiple'] as boolean | undefined,
              body: args['body'] as string | undefined,
              priority: args['priority'] as NewCard['priority'],
              follows: args['follows'] as string | undefined,
              tags: args['tags'] as Record<string, string> | undefined,
              origin,
            });
            return result(`Posted card ${card.id}. The answer arrives as a user message; keep working meanwhile.`);
          }
          case 'card_reply':
            await c.reply(String(args['card_id']), String(args['text'] ?? ''));
            return result('Replied.');
          case 'card_close':
            await c.close(String(args['card_id']), args['kind'] as CloseKind, String(args['outcome'] ?? ''));
            return result('Closed.');
          default: {
            const hits = await c.search(String(args['query'] ?? ''));
            return result(JSON.stringify(hits.map((r) => ({ id: r.card.id, title: r.card.title, answer: r.answer ? describeAnswer(r.card, r.answer) : null })), null, 2));
          }
        }
      },
    });
  }
}
