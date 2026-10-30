// The OpenCode plugin: card tools for the agent, and each answer delivered into its session as a new message.
// OpenCode queues a message sent while a turn runs, so an answer never interrupts the agent. The answer is
// marked read when it reaches the conversation.
//
// OpenCode hands plugins its own Zod, as tool.schema from @opencode-ai/plugin, and wants tool arguments in it.
// The plugin takes that Zod as an argument, so this package needs no Zod of its own.
import os from 'node:os';
import { Client, describeAnswer, describeReturned, loadConfig } from '../../client.ts';
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
    const config = loadConfig();
    if (!config) return {};
    const inbox = new Client(config);
    const secrets = new SecretRequests();
    // The sessions this process follows, each with its answer stream, and the answers sent but not yet read.
    const followed = new Map<string, AbortController>();
    const pending = new Map<string, string>();
    const checked = new Set<string>();

    const send = (session: string, text: string): Promise<unknown> =>
      client.session.promptAsync({ path: { id: session }, body: { parts: [{ type: 'text', text }] } });

    const follow = (session: string): void => {
      if (followed.has(session)) return;
      const stop = new AbortController();
      followed.set(session, stop);
      void inbox.stream(agentOf(session), async (ev: AgentEvent) => {
        if (ev.type === 'guidance') { await send(session, `[your-attention] The person approved new card guidance, version ${ev.guidance.version}. Follow it from now on:\n${ev.guidance.text}`); return; }
        if (ev.type === 'returned') { await send(session, `[your-attention] ${describeReturned(ev)}`); return; }
        if (ev.type !== 'answer') return;
        pending.set(ev.id, ev.card.id);
        const what = ev.card.kind === 'secret' ? await secrets.receive(ev.card, ev.answer) : `The person answered card "${ev.card.title}" (id ${ev.card.id}):\n${describeAnswer(ev.card, ev.answer, await saveAnswerImages(inbox, agentOf(session), ev.answer))}`;
        await send(session, `[your-attention answer ${ev.id}] ${what}`);
      }, stop.signal).catch(() => {});
    };

    // A session from before a restart, seen in an event, is followed when it has a card in the inbox.
    const maybeFollow = async (session: string): Promise<void> => {
      if (followed.has(session) || checked.has(session)) return;
      checked.add(session);
      const mine = (await inbox.list().catch(() => [])).some(({ card, state }) => card.agent === agentOf(session) && state !== 'closed' && state !== 'read');
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
        return runTool({ inbox, secrets, agent: agentOf(ctx.sessionID), origin: () => origin(ctx), arrival: 'as a new message in this session' }, t.name, args);
      },
    }]));

    return {
      tool,
      async event({ event }) {
        const session = event.properties?.sessionID;
        if (session && event.type.startsWith('session.')) await maybeFollow(session);
      },
      async 'chat.message'(_input, output) {
        if (!pending.size) return;
        const text = output.parts.map((p) => p.text ?? '').join('\n');
        for (const [receipt, card] of pending) {
          if (!text.includes(receipt)) continue;
          pending.delete(receipt);
          await inbox.ack(card).catch(() => {});
        }
      },
      async dispose() {
        for (const stop of followed.values()) stop.abort();
        followed.clear();
      },
    };
  };
}
