// Runs a card tool for any harness integration, so Claude Code and pi offer the same tools.
import fs from 'node:fs';
import path from 'node:path';
import { describeAnswer, describeCardFields, describeOpenCards, type Client } from '../client.ts';
import { readsSomething, typeFromName, type SearchFilters } from '../core/inbox.ts';
import type { Approval, AskQuestion, CloseKind, FeedbackFinding, FeedbackVerdict, NewAttachment, NewCard, Option, Origin, PullRequest } from '../core/types.ts';
import type { SecretRequests } from './secrets.ts';
import { envRequireCard, ruleFromView } from './require-card.ts';
import { describeDelays } from '../core/require-card.ts';
import { STEP_MS } from '../core/otp.ts';
import { cardTools, removedTools } from './tools.ts';

export interface ToolContext {
  inbox: Client;
  secrets: SecretRequests;
  agent: string;
  /** Where the session runs, looked up when a tool posts a card, so a renamed session or a moved tab shows. */
  origin: () => Promise<Origin | undefined>;
  /** How the answer reaches this harness, for the tool result: "as a channel event". */
  arrival: string;
  /** Make the session's grants reach its commands, as the first grant of an answer does: pi rebuilds its bash tool and
   * Claude Code opens its socket. It answers why commands won't get them, or undefined when they will. */
  deliverGrants?: () => Promise<string | undefined>;
  /** The clock and the wait card_otp uses, which a test replaces. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The seconds of a code's step that card_otp wants left when the code reaches the command. */
const OTP_MARGIN_MS = 10_000;

/** A file the agent names by path or URL, as the inbox takes it. */
export function toAttachment(a: { path?: string; url?: string; name?: string; alt?: string }): NewAttachment {
  if (a.url) return { src: a.url, name: a.name, alt: a.alt };
  if (!a.path) throw new Error('each attachment needs a path or a url');
  const type = typeFromName(a.path);
  return { src: `data:${type};base64,${fs.readFileSync(a.path).toString('base64')}`, name: a.name ?? path.basename(a.path), alt: a.alt };
}

/** The pull requests a card carries, each as `owner/repo#number`, in the order the card stores them. */
function describePullRequests(value: PullRequest | PullRequest[]): string {
  return (Array.isArray(value) ? value : [value]).map((p) => `${p.owner}/${p.repo}#${p.number}`).join(', ');
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
        // A malformed list is no list: the guard below refuses the card and names what it needs, rather than a TypeError.
        options: Array.isArray(args['options']) ? (args['options'] as OptionArg[]).map((o, i): Option => ({ id: `o${i + 1}`, ...optionArg(o) })) : undefined,
        multiple: args['multiple'] as boolean | undefined,
        approvals: args['approvals'] as Approval[] | undefined,
        questions: Array.isArray(args['questions']) ? (args['questions'] as Parameters<typeof questionArg>[0][]).map(questionArg) : undefined,
        body: str(args['body']),
        html: str(args['html']),
        attachments: Array.isArray(args['attachments']) ? (args['attachments'] as { path?: string; url?: string; name?: string; alt?: string }[]).map(toAttachment) : undefined,
        template: args['template'] ? { name: String(args['template']), version: args['template_version'] === undefined ? undefined : Number(args['template_version']), vars: args['vars'] as Record<string, string> | undefined } : undefined,
        priority: str(args['priority']),
        rating: args['rating'] === undefined ? undefined : Number(args['rating']),
        expiresAt: minutes > 0 ? Date.now() + minutes * 60_000 : undefined,
        follows: str(args['follows']),
        tags: args['tags'] as Record<string, string> | undefined,
        pullRequests: args['pullRequests'] as PullRequest | PullRequest[] | undefined,
        from: str(args['from']),
        origin: await origin(),
      };
      // A card with nothing to read shows the person a title and nothing under it. Refuse it here, where every agent's
      // card_post lands, rather than posting it and letting triage return it until it gives up. `vars` without a template
      // fills no field, so a call that leans on it gets the sentence that names the field the words belong in.
      if (!readsSomething(card)) {
        throw new Error(args['vars'] !== undefined && !args['template']
          ? 'vars fills a template: name one with template, and put the card\'s own text in text'
          : 'a card needs something the person can read: give text, a body, questions, options, html, an attachment, or approvals');
      }
      const sealing = await ctx.secrets.prepare(card.body, (q) => inbox.secretLookup(q));
      const posted = await inbox.post({ ...card, body: sealing.body });
      sealing.keep(posted.id);
      const inherited = posted.inheritedTags ?? [];
      const tags = inherited.length ? `It took the default tags ${inherited.join(', ')}.` : 'It took no default tags.';
      const open = describeOpenCards(posted.openCards);
      const ids = describeCardFields(posted);
      if (posted.warning) return `Saved card ${posted.id} as version ${posted.version}. ${tags} Warning: ${posted.warning}${ids}${open}`;
      const asks = sealing.count ? ` Once answered, each command you run gets each secret as a variable of its name, and you never see the value.` : '';
      return `Posted card ${posted.id}. ${tags} The answer arrives ${ctx.arrival}; keep working meanwhile.${asks}${ids}${open}`;
    }
    case 'card_patch': {
      const card = await inbox.patch(String(args['card_id']), args['edits'] as { old: string; new: string }[], str(args['field']), args['pullRequests'] as PullRequest | PullRequest[] | null | undefined);
      return `Card ${card.id} is now version ${card.version}.${card.warning ? ` Warning: ${card.warning}` : ''}${describeCardFields(card)}`;
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
        ...(card.pullRequests ? [`Pull requests: ${describePullRequests(card.pullRequests)}`] : []),
        ...shown,
        versions ? `${versions} earlier version${versions === 1 ? '' : 's'} exist; card_patch edits the text above.` : 'No earlier version; card_patch edits the text above.',
      ].join('\n\n');
    }
    case 'card_status':
      await inbox.status(String(args['card_id']), String(args['status'] ?? ''));
      return 'Set.';
    case 'card_tag': {
      const card = await inbox.tag(String(args['card_id']), args['tags'] as Record<string, string>);
      const lines = Object.entries(card.tags ?? {}).map(([k, v]) => `${k}: ${v}`);
      return lines.length ? `Card ${card.id} now carries the tags ${lines.join(', ')}.` : `Card ${card.id} now carries no tags.`;
    }
    case 'card_template_save': {
      const t = await inbox.saveTemplate(String(args['name'] ?? ''), String(args['source'] ?? ''), str(args['feedback']));
      return `Saved template ${t.name} version ${t.versions.length}. Use it with card_post, template "${t.name}" and vars.`;
    }
    case 'card_widget_save': {
      const w = await inbox.saveWidget(String(args['name'] ?? ''), String(args['source'] ?? ''), str(args['feedback']), { when: str(args['when']), response: str(args['response']) });
      return `Saved widget ${w.name} version ${w.versions.length}. Place it in a card body or a template with a line: part = widget ${w.name} {"name": "value"}.`;
    }
    case 'card_guidance': {
      // `propose` is the older name of replace_all_with, kept for one release so running sessions don't break.
      const whole = args['replace_all_with'] ?? args['propose'];
      if (args['edits'] !== undefined || whole !== undefined) {
        if (args['edits'] !== undefined && whole !== undefined) throw new Error('propose either edits or replace_all_with, not both');
        const opts = { message: String(args['message'] ?? ''), ...(agent ? { agent } : {}), origin: await origin() };
        const after = `It changes only if the person approves it. The answer and the person's comment arrive ${ctx.arrival}.`;
        if (args['edits'] !== undefined) {
          if (!Array.isArray(args['edits'])) throw new Error('edits must be a list of {old, new}');
          const edits = args['edits'] as { old: string; new: string }[];
          const card = await inbox.proposeGuidance(edits, opts);
          const n = edits.length;
          return `Proposed ${n} edit${n === 1 ? '' : 's'} to guidance version ${card.broadcast?.base?.version ?? '?'} on card ${card.id}. ${after} The edits apply to the guidance as it is at the approval.`;
        }
        const card = await inbox.proposeGuidance(String(whole), opts);
        const deprecated = args['replace_all_with'] === undefined ? ' propose is deprecated: use edits, or replace_all_with for a whole new text.' : '';
        return `Proposed a whole new guidance text on card ${card.id}. It replaces every rule. ${after}${deprecated}`;
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
    case 'card_otp': {
      const ticket = String(args['ticket'] ?? '').trim();
      if (!ticket) throw new Error('give the ticket from the answer to your otp card');
      // A code redeemed in the last seconds of its step dies before the command reads it, so wait for the next step.
      const now = ctx.now ?? Date.now;
      const left = STEP_MS - (now() % STEP_MS);
      if (left < OTP_MARGIN_MS) await (ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); })))(left + 250);
      const r = await inbox.otpRedeem(ticket, agent);
      const line = await ctx.secrets.holdCode(r.card, agent, r.field, r.sealed, r.expiresAt);
      if (line === undefined) throw new Error(`this session no longer has the key of card ${r.card}, so it cannot open the code. The ticket is used: post a new otp card`);
      const warning = ctx.deliverGrants ? await ctx.deliverGrants() : undefined;
      return `The inbox issued a code from the key ${r.key} for "${r.purpose}". ${line}${warning ? `\n${warning}` : ''}`;
    }
    case 'card_close':
      await inbox.close(String(args['card_id']), args['kind'] as CloseKind, String(args['outcome'] ?? ''));
      return 'Closed.';
    case 'card_triage_feedback': {
      const findings = Array.isArray(args['findings']) ? (args['findings'] as FeedbackFinding[]) : undefined;
      const comment = str(args['comment']);
      const card = await inbox.triageFeedback(String(args['card_id']), {
        verdict: args['verdict'] as FeedbackVerdict,
        ...(comment === undefined ? {} : { comment }),
        ...(findings ? { findings } : {}),
      });
      const last = card.pushback?.at(-1);
      return `Recorded your feedback on the pushback by ${last?.by ?? 'triage'} on card ${card.id}${last ? `, version ${last.version}` : ''}. The person reads it on the card.`;
    }
    case 'card_search': {
      // A time filter takes what an agent writes: an ISO date, a date-time, or epoch milliseconds.
      const time = (name: string): number | undefined => {
        const raw = args[name];
        if (raw === undefined || raw === null || raw === '') return undefined;
        const value = typeof raw === 'number' || /^\d+$/.test(String(raw)) ? Number(raw) : Date.parse(String(raw));
        if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an ISO date or epoch milliseconds, and ${String(raw)} is neither`);
        return value;
      };
      const filtered = ['state', 'tags', 'agent', 'since', 'before', 'links', 'triage_feedback'].some((k) => args[k] !== undefined);
      const page = await inbox.search(String(args['query'] ?? ''), {
        // Words alone keep the tool's own default of answered cards. A filter picks the cards itself, so it lifts it.
        answered: args['include_open'] === true || filtered ? undefined : true,
        state: str(args['state']) as SearchFilters['state'],
        tags: Array.isArray(args['tags']) ? (args['tags'] as unknown[]).map(String) : undefined,
        agent: str(args['agent']),
        since: time('since'),
        before: time('before'),
        links: str(args['links']),
        triageFeedback: str(args['triage_feedback']) as SearchFilters['triageFeedback'],
        limit: args['limit'] === undefined ? undefined : Number(args['limit']),
        cursor: str(args['cursor']),
      });
      const results = page.results.map((r) => ({
        id: r.card.id,
        title: r.card.title,
        state: r.state,
        tags: r.card.tags ?? {},
        ...(r.card.pullRequests ? { pullRequests: r.card.pullRequests } : {}),
        agent: r.card.agent,
        posted: new Date(r.card.createdAt).toISOString(),
        updated: new Date(r.card.updatedAt).toISOString(),
        answer: r.answer ? describeAnswer(r.card, r.answer) : null,
        // Each triage pushback, with the agent's verdict on it, so a search for feedback reads it without a card_read.
        ...(r.card.pushback?.length ? { triage_pushback: r.card.pushback.map((p) => ({ by: p.by, kind: p.kind, version: p.version, reason: p.reason, feedback: p.feedback?.verdict ?? null })) } : {}),
      }));
      return JSON.stringify({ results, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) }, null, 2);
    }
    case 'settings': {
      const scope = args['scope'];
      const ruleSays = (rule: { mode: string; agents?: string[] }) => rule.mode === 'all'
        ? 'every agent in this inbox'
        : rule.mode === 'agents' ? `the agents it names: ${(rule.agents ?? []).join(', ')}` : 'no agent in this inbox';
      const says = (on: boolean, delays: number[]) => on
        ? delays.length
          ? `This session must hold an open card. With none open, it is asked for one ${describeDelays(delays)}, counted from when its turn ended.`
          : 'This session is under the rule, and its schedule asks for no card.'
        : 'This session is not asked for a card.';
      if (scope === undefined) {
        // A change without a scope would be read as a request to read the rule, so the call says what it wants.
        if (args['on'] !== undefined || args['delays'] !== undefined || args['reminders'] !== undefined) throw new Error('say scope: self for this session, or all for every agent');
        const view = await inbox.requireCard(agent);
        // A session started with the environment value obeys that value, so the inbox's answer would mislead it.
        const forced = envRequireCard(process.env);
        if (forced) {
          return `${says(forced.on, forced.delays)} YOUR_ATTENTION_REQUIRE_CARD decides for this session until it restarts, so the inbox's rule does not apply to it. That rule asks ${ruleSays(view.rule)}.`;
        }
        return `${says(view.on, ruleFromView(view).delays)} The rule asks ${ruleSays(view.rule)}.`;
      }
      if (typeof args['on'] !== 'boolean') throw new Error('say on: true to ask this session for a card, false to stop asking');
      const on = args['on'];
      if (scope === 'self') {
        // A session the environment decides for cannot change what governs it, and saying otherwise would mislead.
        if (envRequireCard(process.env)) throw new Error('YOUR_ATTENTION_REQUIRE_CARD decides for this session until it restarts, so a self change would have no effect: use scope all to change the rule for every agent');
        // The schedule belongs to the whole inbox, so a self change that named one would be dropped rather than applied.
        if (args['delays'] !== undefined || args['reminders'] !== undefined) throw new Error('the schedule applies to every agent, so change delays with scope all');
        const next = await inbox.setRequireCardForSelf(agent, on);
        return `${says(on, ruleFromView({ on, ...next }).delays)} This took effect at once, for this session only: no card asked the person, because it is your own conduct.`;
      }
      if (scope === 'all') {
        // A schedule is a list of minutes and a count is a number; the inbox checks the values. null and true would
        // otherwise reach the inbox as 0 and 1.
        if (args['delays'] !== undefined && !Array.isArray(args['delays'])) throw new Error('delays must be a list of minutes, such as [2, 5, 10]');
        if (args['reminders'] !== undefined && typeof args['reminders'] !== 'number') throw new Error('reminders must be a whole number');
        const card = await inbox.proposeRequireCard({
          on,
          ...(args['delays'] === undefined ? {} : { delays: args['delays'] as number[] }),
          ...(args['reminders'] === undefined ? {} : { reminders: args['reminders'] }),
          agent,
          origin: await origin(),
        });
        return `Proposed the rule for every agent on card ${card.id}. It changes only if the person approves it, and the answer arrives ${ctx.arrival}.`;
      }
      throw new Error('scope must be self, for this session, or all, for every agent');
    }
  }
  throw new Error(`unknown tool ${name}`);
}
