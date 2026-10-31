// Runs a card tool for any harness integration, so Claude Code and pi offer the same tools.
import fs from 'node:fs';
import path from 'node:path';
import { describeAnswer, type Client } from '../client.ts';
import { typeFromName } from '../core/inbox.ts';
import type { CloseKind, NewAttachment, NewCard, Option, Origin } from '../core/types.ts';
import type { SecretRequests } from './secrets.ts';
import { cardTools } from './tools.ts';

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

export async function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
  const { inbox, agent } = ctx;
  // Where the session runs only labels the card, so a failed lookup posts the card without it.
  const origin = (): Promise<Origin | undefined> => ctx.origin().catch(() => undefined);
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
        // An option is an object with its explanation, or a plain label.
        options: (args['options'] as (string | null | { label?: unknown; description?: unknown; recommended?: unknown })[] | undefined)?.map((o, i): Option => {
          const obj = o && typeof o === 'object' ? o : undefined;
          const label = obj ? String(obj.label ?? '') : String(o ?? '');
          const description = obj ? str(obj.description) : undefined;
          return { id: `o${i + 1}`, label, ...(description ? { description } : {}), ...(obj?.recommended === true ? { recommended: true } : {}) };
        }),
        multiple: args['multiple'] as boolean | undefined,
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
      const posted = await inbox.post(card);
      if (posted.warning) return `Saved card ${posted.id} as version ${posted.version}. Warning: ${posted.warning}`;
      return `Posted card ${posted.id}. The answer arrives ${ctx.arrival}; keep working meanwhile.`;
    }
    case 'card_patch': {
      const card = await inbox.patch(String(args['card_id']), args['edits'] as { old: string; new: string }[], str(args['field']));
      return `Card ${card.id} is now version ${card.version}.${card.warning ? ` Warning: ${card.warning}` : ''}`;
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
        const card = await inbox.proposeGuidance(String(args['propose']));
        return `Proposed the guidance on card ${card.id}. It changes only if the person approves it.`;
      }
      const g = await inbox.guidance();
      return `Card guidance, version ${g.version}:\n${g.text}${g.widgets ? `\n\n${g.widgets}` : ''}`;
    }
    case 'card_ask_secret': {
      const id = await ctx.secrets.ask(inbox, { agent, name: String(args['name'] ?? ''), title: String(args['title'] ?? ''), text: str(args['text']), priority: str(args['priority']) ?? 'now', origin: await origin() });
      return `Asked for the secret on card ${id}. The answer arrives ${ctx.arrival} with the path of a file, never the value.`;
    }
    case 'card_reply':
      await inbox.reply(String(args['card_id']), String(args['text'] ?? ''));
      return 'Replied.';
    case 'card_close':
      await inbox.close(String(args['card_id']), args['kind'] as CloseKind, String(args['outcome'] ?? ''));
      return 'Closed.';
    case 'card_search':
      return JSON.stringify((await inbox.search(String(args['query'] ?? ''), { answered: args['include_open'] !== true, limit: args['limit'] === undefined ? undefined : Number(args['limit']) })).map((r) => ({ id: r.card.id, title: r.card.title, answer: r.answer ? describeAnswer(r.card, r.answer) : null })), null, 2);
  }
  throw new Error(`unknown tool ${name}`);
}
