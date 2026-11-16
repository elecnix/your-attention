// Runs a card tool for any harness integration, so Claude Code and pi offer the same tools.
import fs from 'node:fs';
import path from 'node:path';
import { describeAnswer, type Client } from '../client.ts';
import { typeFromName } from '../core/inbox.ts';
import type { Approval, AskQuestion, CloseKind, NewAttachment, NewCard, Option, Origin } from '../core/types.ts';
import type { SecretRequests } from './secrets.ts';
import { envRequireCard } from './require-card.ts';
import { cardTools, removedTools } from './tools.ts';

export interface ToolContext {
  inbox: Client;
  secrets: SecretRequests;
  agent: string;
  /** Where the session runs, looked up when a tool posts a card, so a renamed session or a moved tab shows. */
  origin: () => Promise<Origin | undefined>;
  /** How the answer reaches this harness, for the tool result: "as a channel event". */
  arrival: string;
}

/** A file the agent names by path or URL, as the inbox takes it. */
export function toAttachment(a: { path?: string; url?: string; name?: string; alt?: string }): NewAttachment {
  if (a.url) return { src: a.url, name: a.name, alt: a.alt };
  if (!a.path) throw new Error('each attachment needs a path or a url');
  const type = typeFromName(a.path);
  return { src: `data:${type};base64,${fs.readFileSync(a.path).toString('base64')}`, name: a.name ?? path.basename(a.path), alt: a.alt };
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

type OptionArg = string | null | { label?: unknown; description?: unknown; recommended?: unknown };
/** An option is an object with its explanation, or a plain label. Only `recommended: true` marks it. */
function optionArg(o: OptionArg): { label: string; description?: string; recommended?: true } {
  const obj = o && typeof o === 'object' ? o : undefined;
  const description = obj ? str(obj.description) : undefined;
  return { label: obj ? String(obj.label ?? '') : String(o ?? ''), ...(description ? { description } : {}), ...(obj?.recommended === true ? { recommended: true } : {}) };
}

/** Each question as the inbox stores it. A field the agent left out stays out. */
function questionArg(q: { question?: unknown; header?: unknown; text?: unknown; options?: OptionArg[]; multiSelect?: unknown }): AskQuestion {
  const header = str(q?.header);
  const text = str(q?.text);
  return {
    question: String(q?.question ?? ''),
    ...(header ? { header } : {}),
    ...(text ? { text } : {}),
    ...(q?.multiSelect === true ? { multiSelect: true } : {}),
    ...(Array.isArray(q?.options) ? { options: q.options.map(optionArg) } : {}),
  };
}

export async function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
  const { inbox, agent } = ctx;
  // Where the session runs only labels the card, so a failed lookup posts the card without it.
  const origin = (): Promise<Origin | undefined> => ctx.origin().catch(() => undefined);
  const removed = Object.hasOwn(removedTools, name) ? removedTools[name] : undefined;
  if (removed) throw new Error(removed);
  // An argument the tool does not take is a mistake to report, not to drop.
  const known = cardTools.find((t) => t.name === name)?.schema['properties'] as Record<string, unknown> | undefined;
  const unknown = known ? Object.keys(args).filter((k) => !(k in known)) : [];
  if (unknown.length) throw new Error(`${name} does not take ${unknown.join(', ')}. It takes ${Object.keys(known ?? {}).join(', ')}.`);
  switch (name) {
    case 'card_post': {
      const minutes = Number(args['expires_in_minutes'] ?? 0);
      const card: NewCard = {
        id: str(args['id']),
        agent,
        title: String(args['title'] ?? ''),
        text: str(args['text']),
        recommendation: str(args['recommendation']),
        options: (args['options'] as OptionArg[] | undefined)?.map((o, i): Option => ({ id: `o${i + 1}`, ...optionArg(o) })),
        multiple: args['multiple'] as boolean | undefined,
        approvals: args['approvals'] as Approval[] | undefined,
        questions: Array.isArray(args['questions']) ? (args['questions'] as Parameters<typeof questionArg>[0][]).map(questionArg) : undefined,
        body: str(args['body']),
        html: str(args['html']),
        attachments: (args['attachments'] as { path?: string; url?: string; name?: string; alt?: string }[] | undefined)?.map(toAttachment),
        template: args['template'] ? { name: String(args['template']), version: args['template_version'] === undefined ? undefined : Number(args['template_version']), vars: args['vars'] as Record<string, string> | undefined } : undefined,
        priority: str(args['priority']),
        rating: args['rating'] === undefined ? undefined : Number(args['rating']),
        expiresAt: minutes > 0 ? Date.now() + minutes * 60_000 : undefined,
        follows: str(args['follows']),
        tags: args['tags'] as Record<string, string> | undefined,
        from: str(args['from']),
        origin: await origin(),
      };
      const sealing = await ctx.secrets.prepare(card.body);
      const posted = await inbox.post({ ...card, body: sealing.body });
      sealing.keep(posted.id);
      const inherited = posted.inheritedTags ?? [];
      const tags = inherited.length ? `It took the default tags ${inherited.join(', ')}.` : 'It took no default tags.';
      if (posted.warning) return `Saved card ${posted.id} as version ${posted.version}. ${tags} Warning: ${posted.warning}`;
      const asks = sealing.count ? ` The answer names a file for each secret, never the value.` : '';
      return `Posted card ${posted.id}. ${tags} The answer arrives ${ctx.arrival}; keep working meanwhile.${asks}`;
    }
    case 'card_patch': {
      const card = await inbox.patch(String(args['card_id']), args['edits'] as { old: string; new: string }[], str(args['field']));
      return `Card ${card.id} is now version ${card.version}.${card.warning ? ` Warning: ${card.warning}` : ''}`;
    }
    case 'card_read': {
      const [id] = [String(args['card_id'])];
      const { card, state } = await inbox.get(id);
      const versions = card.history?.length ?? 0;
      const fields = ['text', 'body', 'html', 'title', 'recommendation'] as const;
      const shown = fields
        .filter((f) => card[f] !== undefined)
        .map((f) => `${f} (${String(card[f]).length} chars):\n${card[f]}`);
      return [
        `Card ${card.id}, version ${card.version}, state ${state}.${card.status ? ` Status: ${card.status}` : ''}`,
        ...shown,
        versions ? `${versions} earlier version${versions === 1 ? '' : 's'} exist; card_patch edits the text above.` : 'No earlier version; card_patch edits the text above.',
      ].join('\n\n');
    }
    case 'card_status':
      await inbox.status(String(args['card_id']), String(args['status'] ?? ''));
      return 'Set.';
    case 'card_template_save': {
      const t = await inbox.saveTemplate(String(args['name'] ?? ''), String(args['source'] ?? ''), str(args['feedback']));
      return `Saved template ${t.name} version ${t.versions.length}. Use it with card_post, template "${t.name}" and vars.`;
    }
    case 'card_widget_save': {
      const w = await inbox.saveWidget(String(args['name'] ?? ''), String(args['source'] ?? ''), str(args['feedback']), { when: str(args['when']), response: str(args['response']) });
      return `Saved widget ${w.name} version ${w.versions.length}. Place it in a card body or a template with a line: part = widget ${w.name} {"name": "value"}.`;
    }
    case 'card_guidance': {
      if (args['propose']) {
        const card = await inbox.proposeGuidance(String(args['propose']), { message: String(args['message'] ?? ''), ...(agent ? { agent } : {}) });
        return `Proposed the guidance on card ${card.id}. It changes only if the person approves it. The answer and the person's comment arrive ${ctx.arrival}.`;
      }
      const g = await inbox.guidance();
      // The tags other cards set go last, one line per key, so the agent reuses a value instead of inventing one.
      const tags = (g.tags ?? []).map((t) => `\`${t.key}\` = ${t.values.map((v) => `${v.value} (${v.count})`).join(', ')}.`);
      // The text arrives without the catalog or the tag lines, so each widget prints once, below the marker that says
      // where the guidance ends; a proposal that rewrites the whole text leaves those lines out.
      const extra = g.widgets ? `\n\nNot part of the guidance text, added to this answer: the widget catalog.\n${g.widgets}` : '';
      return `Card guidance, version ${g.version}:\n${g.text}${extra}${tags.length ? `\n\nNot part of the guidance text either, tag values in use:\n${tags.join('\n')}` : ''}`;
    }
    case 'card_tags': {
      // A call that sends nothing reads the defaults back, which is what an agent does after a compaction.
      const tags = args['tags'] === undefined ? undefined : (args['tags'] as Record<string, string>);
      const remove = Array.isArray(args['remove']) ? (args['remove'] as unknown[]).map(String) : undefined;
      const clear = args['clear'] === true;
      const held = tags !== undefined || remove !== undefined || clear
        ? await inbox.setDefaultTags(agent, { ...(tags === undefined ? {} : { tags }), ...(remove === undefined ? {} : { remove }), ...(clear ? { clear } : {}) })
        : await inbox.defaultTags(agent);
      const lines = Object.entries(held.tags).map(([k, t]) => `- ${k}: ${t.value} (from ${t.from})`);
      return lines.length
        ? `The default tags of this session, which every card it posts inherits under its own tags:\n${lines.join('\n')}`
        : 'This session has no default tags. Set them with card_tags, for example {"tags": {"repo": "acme/api", "topic": "billing"}}, and every card it posts inherits them under its own tags.';
    }
    case 'card_close':
      await inbox.close(String(args['card_id']), args['kind'] as CloseKind, String(args['outcome'] ?? ''));
      return 'Closed.';
    case 'card_search':
      return JSON.stringify((await inbox.search(String(args['query'] ?? ''), { answered: args['include_open'] !== true, limit: args['limit'] === undefined ? undefined : Number(args['limit']) })).map((r) => ({ id: r.card.id, title: r.card.title, answer: r.answer ? describeAnswer(r.card, r.answer) : null })), null, 2);
    case 'settings': {
      const scope = args['scope'];
      const ruleSays = (rule: { mode: string; agents?: string[] }) => rule.mode === 'all'
        ? 'every agent in this inbox'
        : rule.mode === 'agents' ? `the agents it names: ${(rule.agents ?? []).join(', ')}` : 'no agent in this inbox';
      const says = (on: boolean, reminders: number) => on
        ? `This session must hold an open card, asked up to ${reminders} time${reminders === 1 ? '' : 's'} in a stretch without one.`
        : 'This session is not asked for a card.';
      if (scope === undefined) {
        // A change without a scope would be read as a request to read the rule, so the call says what it wants.
        if (args['on'] !== undefined || args['reminders'] !== undefined) throw new Error('say scope: self for this session, or all for every agent');
        const view = await inbox.requireCard(agent);
        // A session started with the environment value obeys that value, so the inbox's answer would mislead it.
        const forced = envRequireCard(process.env);
        if (forced) {
          return `${says(forced.on, forced.reminders)} YOUR_ATTENTION_REQUIRE_CARD decides for this session until it restarts, so the inbox's rule does not apply to it. That rule asks ${ruleSays(view.rule)}.`;
        }
        return `${says(view.on, view.reminders)} The rule asks ${ruleSays(view.rule)}.`;
      }
      if (typeof args['on'] !== 'boolean') throw new Error('say on: true to ask this session for a card, false to stop asking');
      const on = args['on'];
      if (scope === 'self') {
        // A session the environment decides for cannot change what governs it, and saying otherwise would mislead.
        if (envRequireCard(process.env)) throw new Error('YOUR_ATTENTION_REQUIRE_CARD decides for this session until it restarts, so a self change would have no effect: use scope all to change the rule for every agent');
        // The count belongs to the whole inbox, so a self change that named one would be dropped rather than applied.
        if (args['reminders'] !== undefined) throw new Error('the reminder count applies to every agent, so change it with scope all');
        const next = await inbox.setRequireCardForSelf(agent, on);
        return `${says(on, next.reminders)} This took effect at once, for this session only: no card asked the person, because it is your own conduct.`;
      }
      if (scope === 'all') {
        // A count arrives as a number or not at all, since null and true would reach the inbox as 0 and 1.
        if (args['reminders'] !== undefined && typeof args['reminders'] !== 'number') throw new Error('reminders must be a whole number');
        const card = await inbox.proposeRequireCard({ on, ...(args['reminders'] === undefined ? {} : { reminders: args['reminders'] }), agent });
        return `Proposed the rule for every agent on card ${card.id}. It changes only if the person approves it, and the answer arrives ${ctx.arrival}.`;
      }
      throw new Error('scope must be self, for this session, or all, for every agent');
    }
  }
  throw new Error(`unknown tool ${name}`);
}
