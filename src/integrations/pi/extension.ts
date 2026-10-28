// The pi extension: card tools for the agent, and each answer delivered into
// the session as a user message, steering the current turn or starting a new
// one. The answer is marked read when it reaches the model context.
import os from 'node:os';
import { Type } from 'typebox';
import { Client, describeAnswer, loadConfig } from '../../client.ts';
import type { NewCard } from '../../core/types.ts';
import { herdrPlace } from '../herdr/place.ts';
import { SecretRequests } from '../secrets.ts';
import { runTool } from '../run-tool.ts';
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
  const secrets = new SecretRequests();

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
    void client.stream(agent, async (ev) => {
      if (ev.type === 'guidance' || ev.type === 'returned') {
        const note = ev.type === 'guidance'
          ? `[your-attention] The person approved new card guidance, version ${ev.guidance.version}. Follow it from now on:\n${ev.guidance.text}`
          : `[your-attention] Triage sent back card ${ev.card.id} ("${ev.card.title}"): ${ev.reason} Revise it with card_patch or post a better card.`;
        if (ctx.isIdle()) pi.sendUserMessage(note);
        else pi.sendUserMessage(note, { deliverAs: 'followUp' });
        return;
      }
      if (ev.type !== 'answer') return;
      pending.set(ev.id, ev.card.id);
      const what = ev.card.kind === 'secret' ? await secrets.receive(ev.card, ev.answer) : `The person answered card "${ev.card.title}" (id ${ev.card.id}):\n${describeAnswer(ev.card, ev.answer)}`;
      const text = `[your-attention answer ${ev.id}] ${what}`;
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
        return result(await runTool({ inbox: need(), secrets, agent, origin: async () => (origin && { ...origin, ...(await herdrPlace(origin.herdrPane)) }), arrival: 'as a user message' }, tool.name, args));
      },
    });
  }
}
