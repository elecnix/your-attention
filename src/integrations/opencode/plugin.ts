// The OpenCode plugin: card tools for the agent, and each answer delivered into its session as a new message.
// OpenCode queues a message sent while a turn runs, so an answer never interrupts the agent. The answer is
// marked read when it reaches the conversation.
//
// OpenCode hands plugins its own Zod, as tool.schema from @opencode-ai/plugin, and wants tool arguments in it.
// The plugin takes that Zod as an argument, so this package needs no Zod of its own.
import os from 'node:os';
import { Client, describeAdvice, describeAnswer, describeOpenCards, describeReturned, describeSentCard, loadConfig, NO_INBOX, waitForConfig } from '../../client.ts';
import type { AgentEvent, Origin } from '../../core/types.ts';
import { herdrPlace } from '../herdr/place.ts';
import { runTool } from '../run-tool.ts';
import { saveAnswerImages } from '../images.ts';
import { SecretRequests } from '../secrets.ts';
import { cardTools } from '../tools.ts';

// The parts of OpenCode's plugin API this plugin uses.
interface OpenCodeClient {
  session: {
    promptAsync(input: { path: { id: string }; body: { parts: { type: 'text'; text: string }[] } }): Promise<unknown>;
    get(input: { path: { id: string } }): Promise<{ data?: { title?: string } }>;
  };
}
interface PluginInput { client: OpenCodeClient; directory: string }
interface ToolContext { sessionID: string; directory: string }
interface ToolDefinition { description: string; args: Record<string, unknown>; execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> }
interface Hooks {
  tool?: Record<string, ToolDefinition>;
  event?: (input: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>;
  'chat.message'?: (input: { sessionID: string }, output: { message?: unknown; parts: { type: string; text?: string }[] }) => Promise<void>;
  /** The environment of each shell OpenCode starts: the agent's bash tool, with the session's id, and the person's own
   * terminal, without one. */
  'shell.env'?: (input: { cwd: string; sessionID?: string; callID?: string }, output: { env: Record<string, string> }) => Promise<void>;
  /** Each tool's result before the model reads it, which a plugin may change in place. */
  'tool.execute.after'?: (input: { tool: string; sessionID: string; callID: string }, output: { title: string; output: string; metadata: unknown }) => Promise<void>;
  dispose?: () => Promise<void>;
}

// The part of Zod the schema conversion uses.
interface ZodType { describe(text: string): ZodType; optional(): ZodType }
interface Zod {
  string(): ZodType;
  number(): ZodType;
  boolean(): ZodType;
  any(): ZodType;
  enum(values: [string, ...string[]]): ZodType;
  array(item: ZodType): ZodType;
  object(shape: Record<string, ZodType>): ZodType;
  record(key: ZodType, value: ZodType): ZodType;
}

interface JsonSchema {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
}

/** A card tool's JSON Schema as Zod, covering the shapes the card tools use. */
function toZod(z: Zod, s: JsonSchema): ZodType {
  let t: ZodType;
  if (s.enum?.length) t = z.enum(s.enum as [string, ...string[]]);
  else if (s.type === 'string') t = z.string();
  else if (s.type === 'number' || s.type === 'integer') t = z.number();
  else if (s.type === 'boolean') t = z.boolean();
  else if (s.type === 'array') t = z.array(s.items ? toZod(z, s.items) : z.any());
  else if (s.type === 'object' && s.properties) t = z.object(toolArgs(z, s as Record<string, unknown>));
  else if (s.type === 'object') t = z.record(z.string(), typeof s.additionalProperties === 'object' ? toZod(z, s.additionalProperties) : z.any());
  else t = z.any();
  return s.description ? t.describe(s.description) : t;
}

/** The arguments of a card tool, by name, in Zod: the ones its schema does not require are optional. */
export function toolArgs(zod: unknown, schema: Record<string, unknown>): Record<string, ZodType> {
  const z = zod as Zod;
  const s = schema as JsonSchema;
  const required = new Set(s.required ?? []);
  return Object.fromEntries(Object.entries(s.properties ?? {}).map(([name, prop]) => {
    const t = toZod(z, prop);
    return [name, required.has(name) ? t : t.optional()];
  }));
}

const agentOf = (session: string): string => `opencode:${session}`;

/** The plugin, given the Zod OpenCode hands plugins as tool.schema. */
export function createPlugin(z: unknown) {
  return async ({ client, directory }: PluginInput): Promise<Hooks> => {
    // A session can start while its inbox is stopped: the plugin keeps its tools, says why a call cannot reach the
    // inbox, and follows each session's answers once an inbox starts, so nobody has to restart OpenCode.
    const started = loadConfig();
    let inbox: Client | undefined = started ? new Client(started) : undefined;
    const need = (): Client => {
      if (!inbox) throw new Error(NO_INBOX);
      return inbox;
    };
    const secrets = new SecretRequests();
    // The sessions this process follows, each with its answer stream, and the answers sent but not yet read.
    const followed = new Map<string, AbortController>();
    /** This plugin's life: dispose aborts the wait for an inbox along with the streams, so a reload leaves no timer. */
    const lifetime = new AbortController();
    const pending = new Map<string, string>();
    const checked = new Set<string>();

    const send = (session: string, text: string): Promise<unknown> =>
      client.session.promptAsync({ path: { id: session }, body: { parts: [{ type: 'text', text }] } });

    /** Follow a session's answers on the inbox that is known now. A session followed while no inbox runs starts
     * following when one does. */
    const start = (session: string): void => {
      const stop = followed.get(session);
      const box = inbox;
      if (!stop || !box) return;
      void box.stream(agentOf(session), async (ev: AgentEvent) => {
        if (ev.type === 'guidance') { await send(session, `[your-attention] The person approved new card guidance, version ${ev.guidance.version}. Follow it from now on:\n${ev.guidance.text}`); return; }
        if (ev.type === 'returned') { await send(session, `[your-attention] ${describeReturned(ev)}`); return; }
        if (ev.type === 'advice') { await send(session, `[your-attention] ${describeAdvice(ev)}`); return; }
        if (ev.type === 'card') { await send(session, `[your-attention] ${describeSentCard(ev)}`); return; }
        if (ev.type === 'revoke') {
          // A revoke for a grant this session doesn't hold, such as one the inbox kept across a restart, changes nothing.
          if (secrets.revoke(ev.case)) await send(session, `[your-attention] The person revoked ${ev.field} on card ${ev.card.id} (case ${ev.case}). Commands no longer get $${ev.field}.`);
          return;
        }
        if (ev.type !== 'answer') return;
        pending.set(ev.id, ev.card.id);
        const sealed = await secrets.receive(ev.card, ev.answer);
        const what = `The person answered card "${ev.card.title}" (id ${ev.card.id}):\n${describeAnswer(ev.card, ev.answer, await saveAnswerImages(box, agentOf(session), ev.answer))}${sealed ? `\n${sealed}` : ''}${describeOpenCards(ev.openCards)}`;
        await send(session, `[your-attention answer ${ev.id}] ${what}`);
      }, stop.signal, 'auto', { origin: { harness: 'opencode', session, host: os.hostname(), herdrPane: process.env['HERDR_PANE_ID'] } }).catch(() => {});
    };
    const follow = (session: string): void => {
      if (followed.has(session)) return;
      followed.set(session, new AbortController());
      start(session);
    };

    // A session from before a restart, seen in an event, is followed when it has a card in the inbox.
    const maybeFollow = async (session: string): Promise<void> => {
      const box = inbox;
      if (!box || followed.has(session) || checked.has(session)) return;
      checked.add(session);
      const mine = (await box.list().catch(() => ({ results: [] }))).results.some(({ card, state }) => card.agent === agentOf(session) && state !== 'closed' && state !== 'read');
      if (mine) follow(session);
    };

    const origin = async (ctx: ToolContext): Promise<Origin> => {
      const title = await client.session.get({ path: { id: ctx.sessionID } }).then((r) => r.data?.title, () => undefined);
      const pane = process.env['HERDR_PANE_ID'];
      return { harness: 'opencode', session: ctx.sessionID, name: title || undefined, host: os.hostname(), cwd: ctx.directory || directory, herdrPane: pane, ...(await herdrPlace(pane)) };
    };

    const tool = Object.fromEntries(cardTools.map((t): [string, ToolDefinition] => [t.name, {
      description: t.description,
      args: toolArgs(z, t.schema),
      async execute(args, ctx) {
        follow(ctx.sessionID);
        return runTool({ inbox: need(), secrets, agent: agentOf(ctx.sessionID), origin: () => origin(ctx), arrival: 'as a new message in this session' }, t.name, args);
      },
    }]));

    // The sessions followed while the inbox was stopped start following it now, without a restart of OpenCode.
    if (!inbox) {
      void waitForConfig({ signal: lifetime.signal }).then((config) => {
        if (!config || inbox || lifetime.signal.aborted) return;
        inbox = new Client(config);
        for (const session of followed.keys()) start(session);
      });
    }

    return {
      tool,
      async event({ event }) {
        const session = event.properties?.sessionID;
        if (session && event.type.startsWith('session.')) await maybeFollow(session);
      },
      async 'chat.message'(_input, output) {
        if (!pending.size || !inbox) return;
        const text = output.parts.map((p) => p.text ?? '').join('\n');
        for (const [receipt, card] of pending) {
          if (!text.includes(receipt)) continue;
          pending.delete(receipt);
          await inbox.ack(card).catch(() => {});
        }
      },
      // A grant reaches the shells of its own session only. The person's terminal has no session, and gets none.
      async 'shell.env'(input, output) {
        if (input.sessionID) Object.assign(output.env, secrets.env(agentOf(input.sessionID)));
      },
      // A value a command printed reaches the model as [secret NAME].
      async 'tool.execute.after'(_input, output) {
        if (!secrets.received) return;
        output.output = secrets.maskDeep(output.output);
        output.title = secrets.maskDeep(output.title);
        output.metadata = secrets.maskDeep(output.metadata);
      },
      async dispose() {
        lifetime.abort();
        for (const stop of followed.values()) stop.abort();
        followed.clear();
      },
    };
  };
}
