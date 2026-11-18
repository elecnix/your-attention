// The pi extension: card tools for the agent, and each answer delivered into
// the session as a user message, steering the current turn or starting a new
// one. The answer is marked read when it reaches the model context.
import os from 'node:os';
import { Type } from 'typebox';
import { Client, describeAdvice, describeAnswer, describeReturned, describeSentCard, loadConfig } from '../../client.ts';
import type { NewCard } from '../../core/types.ts';
import { herdrPlace } from '../herdr/place.ts';
import { saveAnswerImages } from '../images.ts';
import { createPromptCards, type PromptEvent } from './prompt.ts';
import { SecretRequests } from '../secrets.ts';
import { runTool } from '../run-tool.ts';
import { parseTagsFlag } from '../tags.ts';
import { type CardRule, ENV_REMINDERS, envRequireCard } from '../require-card.ts';
import { cardTools } from '../tools.ts';

// stdout belongs to pi, so a stream that stops for good says why on stderr instead of vanishing.
const log = (...a: unknown[]): void => console.error('[your-attention]', ...a);

/** What a session is asked when a run settles with no open card, once the inbox asks it for one. */
const NO_CARD = '[your-attention] This session has no open card. Post one with card_post that says what you are working on and what you need from the person.';
/** The reminders a session gets when the environment decides the rule, since the inbox's count does not apply to it. */
const CARD_REQUESTS = ENV_REMINDERS;

/**
 * The rule this session obeys. A value in YOUR_ATTENTION_REQUIRE_CARD decides for the whole session and never reads the
 * inbox, so a change there cannot mix with it; starting without the value hands the session back to the inbox.
 */
async function requireCardRule(inbox: Client, agent: string): Promise<CardRule> {
  // A value in the environment decides the session without asking the inbox, so a session cut off from it still
  // behaves the way it was started.
  const forced = envRequireCard(process.env);
  if (forced) return forced;
  try {
    const view = await inbox.requireCard(agent);
    return { on: view.on, reminders: view.reminders };
  } catch (e) {
    log('could not read the card rule:', (e as Error).message);
    return { on: false, reminders: 0 };
  }
}

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
  // A prompt that an extension drew in the terminal: the session waits until that prompt is answered.
  on(event: 'ui_prompt_start', handler: (event: PromptEvent, ctx: PiContext) => void | Promise<void>): void;
  on(event: 'ui_prompt_end', handler: (event: PromptEvent, ctx: PiContext) => void | Promise<void>): void;
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
  // A session waiting on a prompt draws no output, so only pi's own lifecycle tells it apart from a session that
  // thinks. One card reports the span, and an answer on it is typed into this session's pane.
  const prompts = createPromptCards(() => (inbox && origin ? { inbox, agent, origin } : undefined));

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
      if (ev.type === 'guidance' || ev.type === 'returned' || ev.type === 'advice') {
        const note = ev.type === 'guidance'
          ? `[your-attention] The person approved new card guidance, version ${ev.guidance.version}. Follow it from now on:\n${ev.guidance.text}`
          : `[your-attention] ${ev.type === 'advice' ? describeAdvice(ev) : describeReturned(ev)}`;
        if (ctx.isIdle()) pi.sendUserMessage(note);
        else pi.sendUserMessage(note, { deliverAs: 'followUp' });
        return;
      }
      if (ev.type === 'card') {
        // A card the person sent this session from the inbox page: a message to act on, not a question to answer.
        const note = `[your-attention] ${describeSentCard(ev)}`;
        if (ctx.isIdle()) pi.sendUserMessage(note);
        else pi.sendUserMessage(note, { deliverAs: 'followUp' });
        return;
      }
      if (ev.type !== 'answer') return;
      // An answer to a prompt card is typed into the pane, and the model hears nothing: the prompt already asked it.
      if (prompts.owns(ev.card.id)) { await prompts.answered(ev.card, ev.answer); return; }
      pending.set(ev.id, ev.card.id);
      const sealed = await secrets.receive(ev.card, ev.answer);
      const what = `The person answered card "${ev.card.title}" (id ${ev.card.id}):\n${describeAnswer(ev.card, ev.answer, await saveAnswerImages(client, agent, ev.answer))}${sealed ? `\n${sealed}` : ''}`;
      const text = `[your-attention answer ${ev.id}] ${what}`;
      // Steer by default; start a new turn when the agent is idle.
      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: ev.answer.delivery === 'followUp' ? 'followUp' : 'steer' });
    }, stop.signal, 'auto', { origin }).catch((e: Error) => log('stream stopped:', e.message));
  });

  pi.on('session_shutdown', () => {
    void prompts.shutdown();
    stop?.abort();
    stop = undefined;
  });

  // pi draws the prompt and then waits, so the card goes up while nothing moves on the screen. A nested prompt is part
  // of the same span, which pi reports with one start and one end.
  pi.on('ui_prompt_start', (event) => prompts.started(event));
  pi.on('ui_prompt_end', () => prompts.ended());

  // The person can hold every agent they want to hear from to one rule: when a run settles, the session needs an open
  // card. The count resets on any run the request did not start, and it stops at three.
  let asked = 0;
  // The run our own request started. A run that begins for any other reason, such as the person typing, an answer
  // arriving, or a card the person sent, resets the count; the run we asked for must not, or the cap below would
  // never bite.
  let ourRun = false;
  pi.on('agent_start', () => {
    if (ourRun) {
      ourRun = false;
      return;
    }
    asked = 0;
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (!inbox || !ctx.isIdle()) return;
    // The rule comes from the inbox, so turning it on costs no restart.
    const rule = await requireCardRule(inbox, agent);
    if (!rule.on) return;
    let open = false;
    try {
      open = (await inbox.list()).results.some((c) => c.card.agent === agent && c.state === 'open');
    } catch (e) {
      log('could not read the session cards:', (e as Error).message);
      return;
    }
    // A card of its own is what the request asks for, so that resets the count along with any run it did not start.
    if (open) {
      asked = 0;
      return;
    }
    // The reminders the person set are the cap, and 0 means never: a session that cannot post a card is left alone.
    if (asked >= rule.reminders) return;
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
