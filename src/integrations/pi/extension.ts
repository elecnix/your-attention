// The pi extension: card tools for the agent, and each answer delivered into
// the session as a user message, steering the current turn or starting a new
// one. The answer is marked read when it reaches the model context.
import os from 'node:os';
import { Type } from 'typebox';
import { Client, describeAnswer, describeReturned, loadConfig } from '../../client.ts';
import type { NewCard } from '../../core/types.ts';
import { herdrPlace } from '../herdr/place.ts';
import { saveAnswerImages } from '../images.ts';
import { SecretRequests } from '../secrets.ts';
import { runTool } from '../run-tool.ts';
import { parseTagsFlag } from '../tags.ts';
import { cardTools } from '../tools.ts';

// stdout belongs to pi, so a stream that stops for good says why on stderr instead of vanishing.
const log = (...a: unknown[]): void => console.error('[your-attention]', ...a);

/** What a session is asked when a run settles with no open card, once the person opts in with YOUR_ATTENTION_REQUIRE_CARD=1. */
const NO_CARD = '[your-attention] This session has no open card. Post one with card_post that says what you are working on and what you need from the person.';
/** How many times one stretch without a card is asked about. The person chose three. */
const CARD_REQUESTS = 3;

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
  on(event: 'agent_start', handler: (event: unknown, ctx: PiContext) => void | Promise<void>): void;
  on(event: 'agent_settled', handler: (event: { aborted?: boolean }, ctx: PiContext) => void | Promise<void>): void;
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

  pi.on('session_start', async (_event, ctx) => {
    const config = loadConfig();
    if (!config) return;
    inbox = new Client(config);
    const session = ctx.sessionManager.getSessionId();
    agent = `pi:${session}`;
    origin = { harness: 'pi', session, name: ctx.sessionManager.getSessionName?.(), host: os.hostname(), cwd: ctx.sessionManager.getCwd(), herdrPane: process.env['HERDR_PANE_ID'] };
    stop?.abort();
    stop = new AbortController();
    const client = inbox;
    // The launcher's --tags value gives every card this session posts its default tags. The inbox keeps them, so a
    // compaction or a restart leaves them in place.
    const launched = process.env['YOUR_ATTENTION_TAGS'];
    // The write is awaited, so a card this session posts next finds the defaults already in the inbox.
    if (launched) {
      try {
        const tags = parseTagsFlag(launched);
        if (tags) await client.setDefaultTags(agent, { tags, from: 'YOUR_ATTENTION_TAGS' }).catch((e: Error) => log('could not set the default tags:', e.message));
      } catch (e) {
        log('ignoring YOUR_ATTENTION_TAGS:', (e as Error).message);
      }
    }
    void client.stream(agent, async (ev) => {
      if (ev.type === 'guidance' || ev.type === 'returned') {
        const note = ev.type === 'guidance'
          ? `[your-attention] The person approved new card guidance, version ${ev.guidance.version}. Follow it from now on:\n${ev.guidance.text}`
          : `[your-attention] ${describeReturned(ev)}`;
        if (ctx.isIdle()) pi.sendUserMessage(note);
        else pi.sendUserMessage(note, { deliverAs: 'followUp' });
        return;
      }
      if (ev.type !== 'answer') return;
      pending.set(ev.id, ev.card.id);
      const what = ev.card.kind === 'secret' ? await secrets.receive(ev.card, ev.answer) : `The person answered card "${ev.card.title}" (id ${ev.card.id}):\n${describeAnswer(ev.card, ev.answer, await saveAnswerImages(client, agent, ev.answer))}`;
      const text = `[your-attention answer ${ev.id}] ${what}`;
      // Steer by default; start a new turn when the agent is idle.
      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: ev.answer.delivery === 'followUp' ? 'followUp' : 'steer' });
    }, stop.signal).catch((e: Error) => log('stream stopped:', e.message));
  });

  pi.on('session_shutdown', () => {
    stop?.abort();
    stop = undefined;
  });

  // The person can hold every agent they want to hear from to one rule: when a run settles, the session needs an open
  // card. The count resets on any run the request did not start, and it stops at three.
  let asked = 0;
  // The run our own request started. A run that begins for any other reason, such as the person typing or an answer
  // arriving, resets the count; the run we asked for must not, or the cap below would never bite.
  let ourRun = false;
  pi.on('agent_start', () => {
    if (ourRun) {
      ourRun = false;
      return;
    }
    asked = 0;
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (!inbox || process.env['YOUR_ATTENTION_REQUIRE_CARD'] !== '1') return;
    if (!ctx.isIdle()) return;
    let open = false;
    try {
      open = (await inbox.list()).some((c) => c.card.agent === agent && c.state === 'open');
    } catch (e) {
      log('could not read the session cards:', (e as Error).message);
      return;
    }
    // A card of its own is what the request asks for, so that resets the count along with any run it did not start.
    if (open) {
      asked = 0;
      return;
    }
    // Three asks is the cap: a session that cannot post a card is left alone rather than asked forever.
    if (asked >= CARD_REQUESTS) return;
    asked++;
    ourRun = true;
    pi.sendUserMessage(NO_CARD);
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
