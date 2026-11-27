// The pi extension: card tools for the agent, and each answer delivered into
// the session as a user message, steering the current turn or starting a new
// one. The answer is marked read when it reaches the model context.
import os from 'node:os';
import { Type } from 'typebox';
import { Client, describeAdvice, describeAnswer, describeReturned, describeSentCard, loadConfig, NO_INBOX, waitForConfig } from '../../client.ts';
import type { NewCard } from '../../core/types.ts';
import { herdrPlace } from '../herdr/place.ts';
import { saveAnswerImages } from '../images.ts';
import { createPromptCards, type PromptEvent } from './prompt.ts';
import { SecretRequests } from '../secrets.ts';
import { loadPiTools, type PiTools, secretBash } from './secret-bash.ts';
import { runTool } from '../run-tool.ts';
import { parseTagsFlag } from '../tags.ts';
import { CardAsks, memoryStore } from '../card-asks.ts';
import { type CardRule, envRequireCard, holdsCard, minuteMs, NO_CARD, ruleFromView } from '../require-card.ts';
import { cardTools } from '../tools.ts';

// stdout belongs to pi, so a stream that stops for good says why on stderr instead of vanishing.
const log = (...a: unknown[]): void => console.error('[your-attention]', ...a);

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
    return ruleFromView(await inbox.requireCard(agent));
  } catch (e) {
    log('could not read the card rule:', (e as Error).message);
    return { on: false, delays: [] };
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
  // Each tool's result before the model reads it. A handler that returns content replaces it.
  on(event: 'tool_result', handler: (event: ToolResultEvent, ctx: PiContext) => ToolResultChange | undefined | Promise<ToolResultChange | undefined>): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiContext): Promise<ToolResult>;
  }): void;
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
}

interface ToolResultEvent { toolName: string; content: unknown[]; structuredContent?: unknown; details?: unknown }
interface ToolResultChange { content?: unknown[]; structuredContent?: unknown; details?: unknown }

const result = (text: string): ToolResult => ({ content: [{ type: 'text', text }], details: undefined });

/** `tools` loads pi's tools module, which pi maps for its extensions. A test hands in its own. */
export default function yourAttention(pi: PiApi, tools: () => Promise<PiTools | undefined> = loadPiTools): void {
  let inbox: Client | undefined;
  let agent = '';
  let origin: NewCard['origin'];
  /** The session's name now: /name renames a session while it runs, so each use asks pi again. */
  let sessionName: () => string | undefined = () => undefined;
  const here = (): NewCard['origin'] => origin && { ...origin, name: sessionName() };
  let stop: AbortController | undefined;
  // Receipt id -> card id, for answers sent but not yet in the model context.
  const pending = new Map<string, string>();
  const secrets = new SecretRequests();
  /** Whether this session's bash tool adds the grants to each command, which it does from the first grant on. */
  let secretBashOn: Promise<boolean> | undefined;
  const deliverGrants = (cwd: string): Promise<boolean> => {
    secretBashOn ??= tools().then((found) => {
      if (!found) return false;
      const bash = secretBash(found, cwd, secrets, () => agent);
      pi.registerTool({ ...bash, execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => bash.execute(id, params, signal, onUpdate) } as unknown as Parameters<PiApi['registerTool']>[0]);
      return true;
    }, (e: Error) => { log('could not rebuild the bash tool:', e.message); return false; });
    return secretBashOn;
  };
  // A session waiting on a prompt draws no output, so only pi's own lifecycle tells it apart from a session that
  // thinks. One card reports the span, and an answer on it is typed into this session's pane.
  const prompts = createPromptCards(() => (inbox && origin ? { inbox, agent, origin: here() } : undefined));

  pi.on('session_start', async (_event, ctx) => {
    const session = ctx.sessionManager.getSessionId();
    agent = `pi:${session}`;
    sessionName = () => ctx.sessionManager.getSessionName?.();
    origin = { harness: 'pi', session, name: sessionName(), host: os.hostname(), cwd: ctx.sessionManager.getCwd(), herdrPane: process.env['HERDR_PANE_ID'] };
    stop?.abort();
    stop = new AbortController();
    const mine = stop;
    // A session that starts while its inbox is stopped waits for one rather than staying without answers for good.
    const connect = async (client: Client): Promise<void> => {
      inbox = client;
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
        // A new rule may move the next ask, or turn the asks on or off.
        if (ev.type === 'settings') return asks.resync();
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
        if (ev.type === 'revoke') {
          const live = secrets.revoke(ev.case);
          const note = `[your-attention] The person revoked ${ev.field} on card ${ev.card} (case ${ev.case}).${live ? ` Commands no longer get $${ev.field}.` : ''}`;
          if (ctx.isIdle()) pi.sendUserMessage(note);
          else pi.sendUserMessage(note, { deliverAs: 'followUp' });
          return;
        }
        if (ev.type !== 'answer') return;
        // An answer to a prompt card is typed into the pane, and the model hears nothing: the prompt already asked it.
        if (prompts.owns(ev.card.id)) { await prompts.answered(ev.card, ev.answer); return; }
        pending.set(ev.id, ev.card.id);
        let sealed = await secrets.receive(ev.card, ev.answer);
        if (secrets.holds(agent) && !(await deliverGrants(ctx.sessionManager.getCwd()))) {
          sealed += '\nThis pi has no bash tool the extension can rebuild, so its commands do not get these variables. Tell the person.';
        }
        const what = `The person answered card "${ev.card.title}" (id ${ev.card.id}):\n${describeAnswer(ev.card, ev.answer, await saveAnswerImages(client, agent, ev.answer))}${sealed ? `\n${sealed}` : ''}`;
        const text = `[your-attention answer ${ev.id}] ${what}`;
        // Steer by default; start a new turn when the agent is idle.
        if (ctx.isIdle()) pi.sendUserMessage(text);
        else pi.sendUserMessage(text, { deliverAs: ev.answer.delivery === 'followUp' ? 'followUp' : 'steer' });
      }, mine.signal, 'auto', { origin: here }).catch((e: Error) => log('stream stopped:', e.message));
    };
    const config = loadConfig();
    if (config) { await connect(new Client(config)); return; }
    log('no inbox yet: this session connects when one starts');
    void waitForConfig({ signal: mine.signal }).then(async (found) => {
      if (!found || mine.signal.aborted) return;
      await connect(new Client(found));
    }).catch((e: Error) => log('the wait for an inbox stopped:', e.message));
  });

  pi.on('session_shutdown', () => {
    asks.stop();
    void prompts.shutdown();
    stop?.abort();
    stop = undefined;
  });

  // pi draws the prompt and then waits, so the card goes up while nothing moves on the screen. A nested prompt is part
  // of the same span, which pi reports with one start and one end. Both handlers resolve: pi catches neither promise,
  // so a card that fails to post or to close says why on stderr rather than ending the process as an unhandled
  // rejection nobody waits for.
  pi.on('ui_prompt_start', (event) => prompts.started(event).catch((e: Error) => log('the prompt card was not posted:', e.message)));
  pi.on('ui_prompt_end', () => prompts.ended().catch((e: Error) => log('the prompt card was not closed:', e.message)));

  // The person can hold every agent they want to hear from to one rule: a session that goes inactive with no open card
  // is asked for one at the minutes the rule names, counted from when its run settled. The extension lives as long as
  // the session, so the stretch lives in memory.
  const asks = new CardAsks({
    store: memoryStore(),
    rule: async () => (inbox ? requireCardRule(inbox, agent) : { on: false, delays: [] }),
    hasOpenCard: async () => Boolean(inbox && holdsCard((await inbox.list()).results, agent)),
    // The ask starts a run of its own, which agent_start below tells apart from activity.
    ask: () => pi.sendUserMessage(NO_CARD),
    minuteMs: minuteMs(process.env),
    log,
  });
  // A run that starts for any reason but an ask is activity: the person typing, an answer, a card the person sent.
  pi.on('agent_start', () => asks.began());
  pi.on('agent_settled', (_event, ctx) => {
    if (!inbox || !ctx.isIdle()) return;
    asks.ended();
  });

  // A value a command printed reaches the model as [secret NAME], whichever tool read it.
  pi.on('tool_result', (event) => {
    if (!secrets.received) return undefined;
    const content = secrets.maskDeep(event.content);
    const structuredContent = secrets.maskDeep(event.structuredContent);
    if (JSON.stringify(content) === JSON.stringify(event.content) && JSON.stringify(structuredContent) === JSON.stringify(event.structuredContent)) return undefined;
    return { content, ...(event.structuredContent === undefined ? {} : { structuredContent }), details: secrets.maskDeep(event.details) };
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
    if (!inbox) throw new Error(NO_INBOX);
    return inbox;
  };

  for (const tool of cardTools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name.replace('_', ' '),
      description: tool.description,
      parameters: Type.Unsafe(tool.schema),
      async execute(_id, args) {
        return result(await runTool({ inbox: need(), secrets, agent, origin: async () => (origin && { ...here(), ...(await herdrPlace(origin.herdrPane)) }), arrival: 'as a user message' }, tool.name, args));
      },
    });
  }
}
