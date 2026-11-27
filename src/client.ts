// A client for agents and integrations. It finds the inbox in this order:
// 1. YOUR_ATTENTION_URL and YOUR_ATTENTION_TOKEN
// 2. ~/.your-attention/client.json, written by `your-attention pair`
// 3. the inbox running on this machine, with its local agent token
import type { PrivilegedRun } from './core/privileged.ts';
import fs from 'node:fs';
import path from 'node:path';
import { bodyProblemsMessage, checkDiagrams, findDiagrams } from './core/diagrams.ts';
import { InboxError, type SearchFilters, type SearchPage, type TriageFeedbackRecord } from './core/inbox.ts';
import { isSealed, secretAccesses } from './core/sealed.ts';
import type { AccessGrant, Candidate, SecretQuery, SourceInfo } from './core/secret-sources.ts';
import type { AgentEvent, Answer, Card, CardGuidance, CardState, CloseKind, DefaultTags, DefaultTagsWrite, FeedbackFinding, FeedbackVerdict, GuidanceEdit, NewCard, OpenCards, Origin, PublicSubscription, PullRequest, Template } from './core/types.ts';
import { homeDir } from './node/home.ts';
import { questionLines } from '../web/answers.js';
import { cardAge } from '../web/age.js';

export interface ClientConfig {
  url: string;
  token: string;
  /** More links to the same inbox: a relay, a bridge, or an SSH tunnel. The client switches when one fails. */
  urls?: string[];
  /** The inbox id from GET /v1/info. Pairing saves it. Without it, the client learns it from the first link only. */
  id?: string;
}

/** The inbox and token for an extension: YOUR_ATTENTION_URL with YOUR_ATTENTION_TOKEN, or the local extension token. */
export function loadExtensionConfig(home = homeDir()): ClientConfig | undefined {
  const url = process.env['YOUR_ATTENTION_URL'];
  const token = process.env['YOUR_ATTENTION_TOKEN'];
  if (url && token) return { url, token };
  try {
    const server = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')) as { url: string };
    return { url: server.url, token: fs.readFileSync(path.join(home, 'extension-token'), 'utf8').trim() };
  } catch {
    return undefined;
  }
}

export function loadConfig(home = homeDir()): ClientConfig | undefined {
  const url = process.env['YOUR_ATTENTION_URL'];
  const token = process.env['YOUR_ATTENTION_TOKEN'];
  if (url && token) return { url, token };
  const read = (f: string): string | undefined => {
    try { return fs.readFileSync(path.join(home, f), 'utf8').trim(); } catch { return undefined; }
  };
  // A file that does not parse is a file this machine cannot use, the same as a missing one: `status` reports it as
  // unreadable, and every other caller answers "no inbox" rather than a stack trace.
  const parse = (text: string | undefined): unknown => {
    if (!text) return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
  };
  // A file that parses to anything but a pair of strings is a pairing this machine cannot use, the same as a missing
  // one: `status` reports it as unreadable or addressless, and every other caller answers "no inbox" rather than
  // failing on `undefined.replace` or on a URL of 42.
  const usable = (value: unknown): ClientConfig | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;
    const { url, token, urls, id } = value as { url?: unknown; token?: unknown; urls?: unknown; id?: unknown };
    if (typeof url !== 'string' || url === '' || typeof token !== 'string' || token === '') return undefined;
    // `urls` reaches `Client`, which calls `.replace` on each entry, so anything but a list of strings is dropped here
    // rather than crashing there. So is every other field a file may carry.
    const mirrors = Array.isArray(urls) ? urls.filter((u): u is string => typeof u === 'string' && u !== '') : [];
    return { url, token, ...(mirrors.length ? { urls: mirrors } : {}), ...(typeof id === 'string' ? { id } : {}) };
  };
  const paired = usable(read('client.json') === undefined ? undefined : parse(read('client.json')));
  if (paired) return paired;
  const server = usable({ url: (parse(read('server.json')) as { url?: unknown } | undefined)?.url, token: read('agent-token') });
  if (server) return server;
  return undefined;
}

/** Why a tool call cannot reach the inbox, for a session that starts while this machine knows of none. The session
 * waits for an inbox instead of ending, so the error says that a start is all it takes. */
export const NO_INBOX = 'The inbox is not running, and this machine is not paired with one. This session connects when an inbox starts, so start one with `your-attention serve`, or pair with `your-attention pair <url>`.';

/** The config of this machine once an inbox is there: `loadConfig` reads again on an interval until it finds one, or
 * `signal` aborts. An integration calls this at start rather than giving up, because a session that Claude Code saw
 * close its channel never gets the channel back, and the inbox it waits for may start a moment later. */
export async function waitForConfig(opts: { signal?: AbortSignal; everyMs?: number; home?: string } = {}): Promise<ClientConfig | undefined> {
  for (;;) {
    const config = loadConfig(opts.home);
    if (config) return config;
    if (opts.signal?.aborted) return undefined;
    await new Promise<void>((resolve) => { setTimeout(resolve, opts.everyMs ?? 1000); });
    if (opts.signal?.aborted) return undefined;
  }
}

/** The inbox this machine paired with as owner, for the commands that act as the person: owner.json, written by
 * `your-attention pair --role owner`, or an owner pairing that an older version saved in client.json. */
export function ownerPairing(home = homeDir()): (ClientConfig & { source: string }) | undefined {
  for (const f of ['owner.json', 'client.json']) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(home, f), 'utf8')) as ClientConfig;
      if (c.url && c.token) return { ...c, url: c.url.replace(/\/$/, ''), source: path.join(home, f) };
    } catch { /* no such pairing */ }
  }
  return undefined;
}

/** The inbox this machine runs, with its owner token, or undefined when it runs none. */
export function runningHere(home = homeDir()): { url: string; token: string } | undefined {
  try {
    const { url } = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')) as { url?: unknown };
    const token = fs.readFileSync(path.join(home, 'owner-token'), 'utf8').trim();
    return typeof url === 'string' && url && token ? { url, token } : undefined;
  } catch {
    return undefined;
  }
}

/** The inbox to act on as the person: the one this machine runs, or else the one it paired with as owner. */
export function ownerConfig(home = homeDir()): ClientConfig | undefined {
  return runningHere(home) ?? ownerPairing(home);
}

/** What to do on a machine whose only pairing with `url` is an agent's. */
export function notOwnerAdvice(url: string): string {
  return `This machine is paired with ${url} as an agent, so it can't act as you. Pair it as owner with \`your-attention pair ${url} --role owner\`, which keeps the agent pairing. Or open the inbox on your phone from the phone button of a page that is signed in.`;
}

export type Transport = 'auto' | 'sse' | 'ws' | 'poll';

export class Client {
  /** The link in use. */
  url: string;
  /** Every link to the same inbox, tried in order. */
  readonly urls: string[];
  private readonly token: string;
  private inboxId: string | undefined;
  /** Answers already handed to the agent, so one that arrives over two links counts once. */
  private readonly seen = new Set<string>();
  /** This process, the same across reconnects, so the inbox sends a restarted agent the answers its earlier process never read. */
  readonly instance = crypto.randomUUID();
  /** The newest guidance version each agent of this process has seen, from a hello or a guidance event. */
  private readonly guidanceSeen = new Map<string, number>();
  /** What the inbox checks itself, from GET /v1/info. An inbox from before the field checks everything. */
  private inboxChecks: Promise<{ diagrams: boolean; body: boolean }> | undefined;

  constructor(config: ClientConfig) {
    this.urls = [config.url, ...(config.urls ?? [])].map((u) => u.replace(/\/$/, ''));
    this.url = this.urls[0] ?? '';
    this.token = config.token;
    this.inboxId = config.id;
  }

  /** Check that a link leads to the same inbox as the first link. A link to another inbox is skipped,
   * and so is every other link while the client does not know which inbox the first one leads to. */
  private async sameInbox(url: string): Promise<boolean> {
    const idOf = async (u: string): Promise<string | undefined> =>
      ((await (await fetch(`${u}/v1/info`, { signal: AbortSignal.timeout(5000) })).json()) as { id?: string }).id;
    if (!this.inboxId) {
      try { this.inboxId = await idOf(this.urls[0] ?? url); } catch { /* the first link is down */ }
    }
    if (url === this.urls[0]) return true;
    if (!this.inboxId) return false;
    return (await idOf(url)) === this.inboxId;
  }

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    // The same message id on every try, so the inbox applies the message once whichever link brings it.
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' };
    if (method !== 'GET') headers['x-message-id'] = crypto.randomUUID();
    let lastError: unknown;
    for (const url of [this.url, ...this.urls.filter((u) => u !== this.url)]) {
      let res: Response;
      try {
        if (url !== this.url && !(await this.sameInbox(url))) continue;
        res = await fetch(`${url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        lastError = e;
        continue;
      }
      this.url = url;
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${data.error ?? ''}`.trim());
      return data;
    }
    throw new Error(`${method} ${route}: no link answered (${(lastError as Error)?.message ?? 'none tried'})`);
  }

  /** True the first time an answer is seen, false for a copy from another link or a replay. */
  private fresh(ev: AgentEvent): boolean {
    if (ev.type !== 'answer') return true;
    const key = `${ev.card.id}:${ev.answer.savedAt}:${ev.answer.forcedAt ?? 0}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  /** The bytes of a file on a card this client posted, such as an image the person pasted into an answer. */
  async attachment(id: string): Promise<Uint8Array<ArrayBuffer>> {
    let lastError: unknown;
    for (const url of [this.url, ...this.urls.filter((u) => u !== this.url)]) {
      try {
        if (url !== this.url && !(await this.sameInbox(url))) continue;
        const res = await fetch(`${url}/v1/attachments/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${this.token}` } });
        if (!res.ok) throw new Error(`GET /v1/attachments/${id}: ${res.status}`);
        this.url = url;
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(`no link answered (${(lastError as Error)?.message ?? 'none tried'})`);
  }

  /** The posted card. A revision the person won't see carries `warning`, `inheritedTags` names the keys the card
   * took from the agent's default tags, and `openCards` lists the agent's other open cards. */
  async post(card: NewCard): Promise<Card & { warning?: string; inheritedTags?: string[]; openCards?: OpenCards }> {
    await this.checkFirst('POST /v1/cards', { card: { ...card, attachments: undefined } });
    return this.call('POST', '/v1/cards', card);
  }

  /** The candidates the inbox's secret sources offer for a query: metadata, never a value. */
  secretLookup(query: SecretQuery): Promise<{ candidates: Candidate[]; sources: SourceInfo[] }> {
    return this.call('POST', '/v1/secrets/lookup', query);
  }

  /** The default tags this token keeps for one agent id: every card that agent posts inherits them. */
  defaultTags(agent: string): Promise<DefaultTags> {
    return this.call('GET', `/v1/tags?agent=${encodeURIComponent(agent)}`);
  }

  /** Set, merge, remove or clear the default tags this token keeps for one agent id. */
  setDefaultTags(agent: string, write: Omit<DefaultTagsWrite, 'agent'>): Promise<DefaultTags> {
    return this.call('PUT', '/v1/tags', { agent, ...write });
  }

  /** An inbox that does not check diagrams or bodies itself, such as the hosted one, takes them unchecked. So the client
   * reads what the inbox would store, after templates and widgets, and checks it as a laptop inbox would, before it sends the card.
   * It fails with the laptop inbox's own words. */
  private async checkFirst(route: string, req: { card?: NewCard; id?: string; edits?: { old: string; new: string }[]; field?: string | undefined; pullRequests?: PullRequest | PullRequest[] | null }): Promise<void> {
    this.inboxChecks ??= this.call<{ checks?: { diagrams: boolean; body: boolean } }>('GET', '/v1/info')
      .then((i) => i.checks ?? { diagrams: true, body: true }, (e: unknown) => { this.inboxChecks = undefined; throw e; });
    const checks = await this.inboxChecks;
    if (checks.diagrams && checks.body) return;
    const fields = await this.call<{ text?: string; recommendation?: string; body?: string }>('POST', '/v1/preview', req);
    try {
      // Mermaid loads on the first diagram, and the OpenUI parser on the first body.
      const diagrams = findDiagrams(fields);
      if (!checks.diagrams && diagrams.length) await checkDiagrams(diagrams, (await import('./adapters/mermaid.ts')).checkMermaid);
      const problems = !checks.body && fields.body !== undefined ? (await import('./adapters/openui-body.ts')).bodyErrors(fields.body) : [];
      if (problems.length) throw new InboxError(400, bodyProblemsMessage(problems));
    } catch (e) {
      if (e instanceof InboxError) throw new Error(`${route}: ${e.status} ${e.message}`);
      throw e;
    }
  }

  list(opts: SearchFilters = {}): Promise<{ results: { card: Card; state: CardState }[]; nextCursor?: string }> {
    return this.call('GET', `/v1/cards${filterParams(opts)}`);
  }
  get(id: string): Promise<{ card: Card; state: string }> { return this.call('GET', `/v1/cards/${encodeURIComponent(id)}`); }
  close(id: string, kind: CloseKind, outcome: string, ifUnanswered = false): Promise<Card> {
    return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/close`, { kind, outcome, ifUnanswered });
  }
  async patch(id: string, edits: { old: string; new: string }[], field?: string, pullRequests?: PullRequest | PullRequest[] | null): Promise<Card & { warning?: string }> {
    const route = `/v1/cards/${encodeURIComponent(id)}/patch`;
    await this.checkFirst(`POST ${route}`, { id, edits, field, pullRequests });
    return this.call('POST', route, { edits, field, pullRequests });
  }
  status(id: string, status: string): Promise<Card> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/status`, { status }); }
  /** Merge tags into a card already posted, and drop a key whose value is empty. */
  tag(id: string, tags: Record<string, string>): Promise<Card> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/tags`, { tags }); }
  saveTemplate(name: string, source: string, feedback?: string): Promise<Template> { return this.call('POST', '/v1/templates', { name, source, feedback }); }
  saveWidget(name: string, source: string, feedback?: string, extra: { when?: string; response?: string } = {}): Promise<Template> { return this.call('POST', '/v1/widgets', { name, source, feedback, ...extra }); }
  /** The card guidance: the editable text, the catalog of widgets an agent can place, and the tags in use. */
  guidance(): Promise<CardGuidance> { return this.call('GET', '/v1/guidance'); }
  /** Propose new guidance as `agent`, which receives the person's answer and comment on the card. A list of edits
   * changes the passages it names; a string replaces every rule, sent under both names so an inbox from before
   * replace_all_with still reads it. `origin` is where the agent runs, which the card shows. */
  proposeGuidance(proposal: string | GuidanceEdit[], opts: { message: string; agent?: string; origin?: Origin }): Promise<Card> {
    return this.call('POST', '/v1/guidance', { ...(typeof proposal === 'string' ? { replace_all_with: proposal, text: proposal } : { edits: proposal }), ...opts });
  }
  /** The require-a-card rule resolved for one session, and the rule itself. */
  requireCard(agent: string): Promise<{ on: boolean; delays?: number[]; reminders: number; rule: { mode: string; agents?: string[]; delays?: number[]; reminders: number } }> {
    return this.call('GET', `/v1/settings/require-card?agent=${encodeURIComponent(agent)}`);
  }
  /** Turn the rule on or off for this session alone. Its own conduct, so no card asks the person. */
  setRequireCardForSelf(agent: string, on: boolean): Promise<{ mode: string; agents?: string[]; delays?: number[]; reminders: number }> {
    return this.call('POST', '/v1/settings/require-card', { scope: 'self', on, agent });
  }
  /** Propose the rule for every agent, as a card the person approves or rejects. */
  proposeRequireCard(input: { on: boolean; delays?: number[]; reminders?: number; agent: string; origin?: Origin }): Promise<Card> {
    return this.call('POST', '/v1/settings/require-card', { scope: 'all', ...input });
  }
  /** Tell the inbox whether triage was right to push back on this client's card. */
  triageFeedback(id: string, feedback: { verdict: FeedbackVerdict; comment?: string; findings?: FeedbackFinding[] }): Promise<Card> {
    return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/triage-feedback`, feedback);
  }
  /** For the owner: every card triage pushed back on, with the agent's feedback and how the card ended. */
  async triageFeedbackRecords(filter?: SearchFilters['triageFeedback']): Promise<TriageFeedbackRecord[]> {
    const reply = await this.call<{ records?: TriageFeedbackRecord[] }>('GET', `/v1/triage-feedback${filter ? `?triage_feedback=${encodeURIComponent(filter)}` : ''}`);
    return Array.isArray(reply?.records) ? reply.records : [];
  }
  ack(id: string): Promise<Answer> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/ack`, {}); }
  claim(id: string, agent: string): Promise<Card> { return this.call('POST', `/v1/cards/${encodeURIComponent(id)}/claim`, { agent }); }
  /** Cards that match the words and the filters. An empty query, or `*`, lists by the filters alone, and a
   * `nextCursor` reads the page after this one. */
  search(q: string, opts: SearchFilters = {}): Promise<SearchPage> {
    return this.call('GET', `/v1/search${filterParams({ q, ...opts })}`);
  }
  deadLetters(): Promise<{ card: Card; answer: Answer }[]> { return this.call('GET', '/v1/dead-letters'); }
  /** The answers this client has not acknowledged, with their card ids. Every field is checked: an address that answers
   * with JSON of its own can leave `cards` out, and a caller that trusts it reads `.length` of nothing. */
  async unread(agent?: string): Promise<{ unread: number; cards: string[] }> {
    const reply = await this.call<{ unread?: unknown; cards?: unknown }>('GET', `/v1/unread${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`);
    const cards = Array.isArray(reply?.cards) ? reply.cards.filter((c): c is string => typeof c === 'string') : [];
    const unread = typeof reply?.unread === 'number' && Number.isFinite(reply.unread) ? reply.unread : cards.length;
    return { unread, cards };
  }
  /** Ask the inbox to send the answers to this agent's cards to a webhook. The owner approves it on a system card, and the
   * secret that signs each call comes back here once. */
  subscribe(agent: string, webhook: { url: string; headers?: Record<string, string> }, origin?: Origin): Promise<{ subscription: PublicSubscription; card: Card; secret: string }> {
    return this.call('POST', '/v1/cards', { agent, kind: 'system', title: `Send the answers for ${agent} to a webhook`, ...(origin ? { origin } : {}), system: { type: 'subscribe', webhook, events: ['answer'] } });
  }
  unsubscribe(agent: string): Promise<{ removed: number }> {
    return this.call('POST', '/v1/cards', { agent, kind: 'system', title: `Stop sending the answers for ${agent} to a webhook`, system: { type: 'unsubscribe' } });
  }
  subscriptions(): Promise<PublicSubscription[]> { return this.call('GET', '/v1/subscriptions'); }

  /** Receive answers for one agent until `signal` aborts. Reconnects after a drop, over the next link when one fails.
   * `auto`, the default, uses a WebSocket and falls back to server-sent events on a link that cannot carry one.
   * `poll` long-polls, for clients that cannot keep a connection. `channelOff` tells the inbox that this session
   * discards channel notifications, so the person sees why an answer does not arrive. `origin` says where the session
   * runs, so the inbox labels it on a card before it posts one. An origin given as a function is read again every
   * `originEveryMs`, 20 seconds unless set, and a change, such as a renamed session, reaches the inbox without a
   * reconnect: an origin frame over the socket, the address of the next long-poll, or a new event stream. */
  async stream(agent: string, onEvent: (ev: AgentEvent) => void | Promise<void>, signal: AbortSignal, transport: Transport = 'auto', opts: { channelOff?: boolean; origin?: Origin | (() => Origin | undefined); originEveryMs?: number } = {}): Promise<void> {
    const originNow = (): Origin | undefined => {
      if (typeof opts.origin !== 'function') return opts.origin;
      try { return opts.origin(); } catch { return reported; }
    };
    /** The origin the inbox has, or gets with the next connection. */
    let reported: Origin | undefined;
    reported = originNow();
    // The origin rides in the address, the one place every transport carries at connect: a browser socket sends no
    // headers, and the event stream and the long-poll have no frame for it.
    const params = (): string => `${opts.channelOff ? '&channel=off' : ''}${reported ? `&origin=${encodeURIComponent(JSON.stringify(reported))}` : ''}`;
    /** What the open transport does with a changed origin. With none open, the next connection carries it. */
    let onOrigin: ((o: Origin) => void) | undefined;
    const watch = typeof opts.origin === 'function'
      ? setInterval(() => {
        const o = originNow();
        // Only a change goes out, so an unchanged name costs the inbox nothing.
        if (!o || JSON.stringify(o) === JSON.stringify(reported)) return;
        reported = o;
        onOrigin?.(o);
      }, opts.originEveryMs ?? 20_000)
      : undefined;
    // The watch must not keep a process alive that has nothing else to do.
    watch?.unref?.();
    let link = 0;
    const noSocket = new Set<string>();
    // A link that answered 410 for its event stream serves events over its socket only. Asking it again every
    // second is what woke a hosted inbox's Durable Object ~35 times a second, so it is never asked again.
    const noStream = new Set<string>();
    const deliver = async (ev: AgentEvent): Promise<void> => {
      if (!this.fresh(ev)) return;
      // Record a guidance version before the handler runs, so a fetch that a hello started never hands over older text.
      if (ev.type === 'guidance') this.guidanceSeen.set(agent, Math.max(this.guidanceSeen.get(agent) ?? 0, ev.guidance.version));
      await onEvent(ev);
      // The inbox sends guidance events only to agents online at the approval. A hello on a reconnect carries the
      // current version, so an agent that was away when the person approved a newer one fetches it and gets it here.
      if (ev.type !== 'hello') return;
      const known = this.guidanceSeen.get(agent);
      // The first hello of this process sets the version it starts from.
      if (known === undefined) { this.guidanceSeen.set(agent, ev.guidance); return; }
      if (ev.guidance <= known) return;
      try {
        const g = await this.guidance();
        // A guidance event may have arrived while the fetch ran: hand over the fetched text only when it is newer still.
        if (g.version <= (this.guidanceSeen.get(agent) ?? 0)) return;
        this.guidanceSeen.set(agent, g.version);
        await onEvent({ type: 'guidance', id: `hello-${g.version}`, guidance: { text: g.text, version: g.version, at: g.at } });
      } catch { /* the next hello tries again, and the agent can read the guidance with card_guidance */ }
    };
    // A retry after a failure waits longer each time, so an inbox that is down, or that refuses a transport,
    // is not woken once a second forever. A transport that ran to its end resets the count.
    let failures = 0;
    const backoff = (): number => {
      const base = Math.min(30_000, 1000 * 2 ** Math.min(Math.max(failures, 1) - 1, 5));
      return Math.round(base * (0.8 + Math.random() * 0.4));
    };
    try {
      while (!signal.aborted) {
        const url = this.urls[link % this.urls.length] ?? this.url;
        let wait = 1000;
        try {
          if (this.urls.length > 1 && !(await this.sameInbox(url))) throw new Error('another inbox');
          this.url = url;
          // The event stream is a fallback for a link whose socket does not open, and only until it refuses.
          const overStream = transport === 'sse' || (transport === 'auto' && noSocket.has(url) && !noStream.has(url));
          let ran = true;
          if (transport === 'poll') await this.overPoll(url, agent, deliver, signal, params);
          else if (overStream) {
            // An event stream has no frame for the client to send, so a new origin opens a new stream that carries it.
            const restart = new AbortController();
            const both = AbortSignal.any([signal, restart.signal]);
            onOrigin = () => restart.abort();
            try {
              await this.overSse(url, agent, deliver, both, params());
            } catch (e) {
              if (!restart.signal.aborted || signal.aborted) throw e;
            } finally {
              onOrigin = undefined;
            }
            if (restart.signal.aborted && !signal.aborted) wait = 0;
          } else {
            // A rename between building the address and the socket opening moved `reported` past what the address
          // carries, so the socket sends it as soon as it opens.
          const carried = reported;
          const opened = await this.overSocket(url, agent, deliver, signal, params(), (send) => {
            onOrigin = send;
            if (send && reported && JSON.stringify(reported) !== JSON.stringify(carried)) send(reported);
          });
            onOrigin = undefined;
            // A socket that never opened on a link that answers means the link cannot carry one. A link that does not answer is down: retry it.
            if (!opened && transport === 'auto') {
              if (!(await this.answers(url))) throw new Error('the link is down');
              noSocket.add(url);
              ran = false;
              // Try the stream once when the link has not refused it; otherwise wait before the next socket.
              wait = noStream.has(url) ? (failures++, backoff()) : 0;
            }
          }
          if (ran) failures = 0;
        } catch (e) {
          if (signal.aborted) return;
          const status = (e as { status?: number }).status;
          if (status === 410) {
            // The inbox serves events over its socket only, as a hosted inbox does. An explicit transport asked for
            // a stream that this link will never serve, so it reports instead of retrying.
            if (transport !== 'auto') throw e;
            noStream.add(url);
            failures++;
            wait = backoff();
          } else if (status === 401 || status === 403 || status === 404) {
            // A token or address the inbox refuses stays refused: report it instead of retrying forever.
            throw e;
          } else {
            link++;
            failures++;
            wait = backoff();
          }
        }
        if (wait === 0) continue;
        if (!signal.aborted) await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      // A stream that ends by a refusal returns without an abort, and the watch must end with it.
      clearInterval(watch);
    }
  }

  private async answers(url: string): Promise<boolean> {
    try { return (await fetch(`${url}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
  }

  private async overSse(url: string, agent: string, deliver: (ev: AgentEvent) => Promise<void>, signal: AbortSignal, params: string): Promise<void> {
    const res = await fetch(`${url}/v1/stream?agent=${encodeURIComponent(agent)}&instance=${this.instance}${params}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw new TransportRefused('stream', res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, end).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(end + 2);
        if (!data) continue;
        const ev = JSON.parse(data.slice(6)) as AgentEvent | { type: 'beat' };
        if (ev.type !== 'beat') await deliver(ev);
      }
    }
  }

  /** Resolves when the socket closes: true if it opened first, false if it never did. */
  /** `setOrigin` receives the function that sends a new origin over the open socket. */
  private overSocket(url: string, agent: string, deliver: (ev: AgentEvent) => Promise<void>, signal: AbortSignal, params: string, setOrigin: (send: ((o: Origin) => void) | undefined) => void = () => {}): Promise<boolean> {
    return new Promise((resolve) => {
      let opened = false;
      const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/v1/ws?agent=${encodeURIComponent(agent)}&instance=${this.instance}${params}`);
      // An abort ends the stream now: a socket close waits for the far end's answer, and an idle inbox may not send
      // one for as long as the process lives, which would leave a stopped client unable to exit.
      const stop = (): void => { ws.close(); done(); };
      signal.addEventListener('abort', stop, { once: true });
      // The global WebSocket cannot send headers, so the token goes in the first frame.
      // The client pings every 20 seconds. A Durable Object answers without waking, and closes a socket that stops.
      let beat: ReturnType<typeof setInterval> | undefined;
      ws.addEventListener('open', () => {
        opened = true;
        ws.send(JSON.stringify({ type: 'auth', token: this.token }));
        beat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); }, 20_000);
        setOrigin((origin) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'origin', origin })); });
      });
      ws.addEventListener('message', (m) => {
        let ev: { type?: string } | null;
        try { ev = JSON.parse(String(m.data)) as { type?: string } | null; } catch { return ws.close(); }
        // A beat only says the stream is alive, as it does over the event stream and the long-poll, so it never reaches
        // the caller as an agent event.
        if (ev && typeof ev === 'object' && ev.type !== 'pong' && ev.type !== 'error' && ev.type !== 'beat') deliver(ev as AgentEvent).catch(() => ws.close());
      });
      let ended = false;
      const done = (): void => {
        if (ended) return;
        ended = true;
        if (beat !== undefined) clearInterval(beat);
        setOrigin(undefined);
        signal.removeEventListener('abort', stop);
        ws.close();
        resolve(opened);
      };
      ws.addEventListener('close', done);
      // A socket that fails to connect fires error and may never fire close.
      ws.addEventListener('error', done);
    });
  }

  /** Each request reads `params` again, so a changed origin rides on the next one. */
  private async overPoll(url: string, agent: string, deliver: (ev: AgentEvent) => Promise<void>, signal: AbortSignal, params: () => string): Promise<void> {
    while (!signal.aborted) {
      const res = await fetch(`${url}/v1/poll?agent=${encodeURIComponent(agent)}&instance=${this.instance}${params()}&wait=25`, { headers: { authorization: `Bearer ${this.token}` }, signal });
      if (!res.ok) throw new TransportRefused('poll', res.status);
      for (const ev of ((await res.json()) as { events: AgentEvent[] }).events) await deliver(ev);
    }
  }
}

/** The address parameters of a search or a cards listing, by the filter each one carries. `format=page` tells the
 * inbox this client reads `{results, nextCursor?}`; without it the inbox answers the plain array older clients map over. */
function filterParams(opts: SearchFilters & { q?: string }): string {
  const p = new URLSearchParams();
  p.set('format', 'page');
  if (opts.q !== undefined) p.set('q', opts.q);
  if (opts.answered) p.set('answered', '1');
  if (opts.state) p.set('state', opts.state);
  for (const tag of opts.tags ?? []) p.append('tags', tag);
  if (opts.agent) p.set('agent', opts.agent);
  if (opts.since !== undefined) p.set('since', String(opts.since));
  if (opts.before !== undefined) p.set('before', String(opts.before));
  if (opts.links) p.set('links', opts.links);
  if (opts.triageFeedback) p.set('triage_feedback', opts.triageFeedback);
  if (opts.limit !== undefined) p.set('limit', String(opts.limit));
  if (opts.cursor) p.set('cursor', opts.cursor);
  const query = p.toString();
  return query ? `?${query}` : '';
}

/** A transport the inbox answered with an HTTP status instead of a stream, so the loop can tell permanent from transient. */
class TransportRefused extends Error {
  readonly status: number;
  constructor(name: string, status: number) {
    super(`${name}: ${status}`);
    this.status = status;
  }
}

/** Plain text for an answer, as an agent reads it. */
/** What an integration tells the agent about a card that triage or the inbox page sent back. */
export function describeReturned(ev: Extract<AgentEvent, { type: 'returned' }>): string {
  const notice = `${ev.by ?? 'Triage'} sent back card ${ev.card.id} ("${ev.card.title}"): ${ev.reason} Revise it with card_patch or post a better card.`;
  // Only a triage extension's return takes feedback, so only its notice asks for it.
  return ev.extension ? `${notice} If this pushback was wrong, or right only in part, say so with card_triage_feedback, so the person can tune the gate.` : notice;
}

/** What an integration tells the agent about advice that triage gave on a card it let through to the person. */
export function describeAdvice(ev: Extract<AgentEvent, { type: 'advice' }>): string {
  // Advice comes only from a triage extension's pass, and the inbox records it as a pushback entry, so every advice
  // notice can take feedback. A return can come from the inbox page as well, which is why describeReturned checks.
  return `${ev.by ?? 'Triage'} let card ${ev.card.id} ("${ev.card.title}") through to the person, with advice for this card and the next ones: ${ev.advice} The card is with the person now, so revise it with card_patch only if the advice changes what the person needs to decide. If this advice was wrong, or right only in part, say so with card_triage_feedback, so the person can tune the gate.`;
}

/** What an integration tells the agent about a card the person sent it from the inbox page. It asks for no answer:
 * the agent replies with a card of its own, and the person finds it in the queue. */
export function describeSentCard(ev: Extract<AgentEvent, { type: 'card' }>): string {
  const text = ev.card.text ? `:\n${ev.card.text}` : '.';
  return `The person sent this session a card, ${ev.card.id}: "${ev.card.title}"${text} Reply with a card of your own if there is something to say, and carry on with what you were doing.`;
}

/** How each close kind reads in a late answer's first line, said to the agent that closed the card. */
const LATE_CLOSE: Record<CloseKind, string> = {
  retracted: 'retracted it',
  'self-answered': 'answered it yourself',
  'answered-in-terminal': 'had it answered in the terminal',
  resolved: 'marked it no longer needed',
  expired: 'let it expire',
  returned: 'had it sent back by triage',
  dismissed: 'saw it dismissed',
};

/** How a line names the state of a card its agent still waits on. An answer the agent has not read comes first in its
 * line, because it is what the agent most needs to act on. */
const WAITING: Partial<Record<CardState, string>> = {
  answered: 'ANSWERED, unread',
  delivered: 'ANSWERED, unread',
  'in-triage': 'in triage',
  held: 'held by triage',
  orphaned: 'open',
  open: 'open',
};

/** The agent's other open cards, one line each, oldest first, after a blank line: what a card_post reply and an answer
 * event end with. An inbox from before the list sends none, and then this says nothing. */
export function describeOpenCards(open: OpenCards | undefined): string {
  if (!open) return '';
  if (open.total === 0) return '\n\nYou have no other open cards.';
  const lines = open.cards.map((c) => `- ${c.id} "${c.title}": ${WAITING[c.state] ?? c.state}, priority ${c.priority}, posted ${cardAge(open.at - c.createdAt)}`);
  const more = open.total - open.cards.length;
  const head = `You have ${open.total} other open card${open.total === 1 ? '' : 's'}, oldest first:`;
  return `\n\n${[head, ...lines, ...(more > 0 ? [`… and ${more} more`] : [])].join('\n')}`;
}

export function describeAnswer(card: Card, answer: Answer, imagePaths?: string[]): string {
  const lines: string[] = [];
  // A late answer says so first, with the agent's own close quoted, so the agent weighs it against what it did since.
  const late = answer.late;
  if (late) lines.push(`Late answer: you had already closed this card when the person sent this. You ${LATE_CLOSE[late.kind] ?? 'closed it'}, with the outcome "${late.outcome}". Act on it if it still matters, or post a new card that follows this one.`, '');
  if (card.questions?.length) lines.push(...questionLines(card, answer.values));
  card.approvals?.forEach((a, i) => {
    const r = answer.approvalResults?.[i];
    // Only a recorded send reads as sent: an answer with no result entry says nothing about the pane.
    const done = late ? 'not sent, because the card was closed when the person answered'
      : !answer.values[`approval_${i}`] ? 'not approved'
      : r && 'sentAt' in r ? 'approved, and the inbox typed it into the pane as the person\'s message'
      : r && 'error' in r ? `approved, but not sent: ${r.error}`
      : 'approved, but the inbox recorded no send';
    lines.push(`Approval ${i + 1} for pane ${a.pane}, "${a.text}": ${done}`);
  });
  // A secret_access field says whether the person granted it, never its value. One the answer leaves out was declined.
  const access = new Set(card.body === undefined ? [] : (() => { try { return secretAccesses(String(card.body)).map((f) => f.name); } catch { return []; } })());
  for (const name of access) {
    const v = answer.values[name] as Partial<AccessGrant> | undefined;
    if (v && typeof v.grant === 'string') {
      // The inbox stores `until` in epoch milliseconds. Any other shape loses only the deadline, never the answer text.
      const until = typeof v.until === 'number' && Number.isFinite(v.until) ? `until ${new Date(v.until).toISOString()}` : 'no deadline given';
      lines.push(`${name}: ${v.revokedAt === undefined ? 'granted' : 'revoked'} (case ${v.case}, ${until})`);
    }
    else if (!isSealed(v)) lines.push(`${name}: declined`);
  }
  // A privileged action says what ran, where, and what it printed, which the inbox masked. It never holds a password.
  for (const name of card.privileged ?? []) {
    const v = answer.values[name] as Partial<PrivilegedRun> | undefined;
    if (!v || typeof v.command !== 'string') { lines.push(`${name}: not run, because the person sent no password or approval`); continue; }
    // A run with no exit code ended early or never started, and `ended` says which, such as a refused connection.
    const head = v.exitCode === null || v.exitCode === undefined ? `${name}: on ${v.machine}, ${v.ended ?? 'the run ended with no exit code'}` : `${name}: ran on ${v.machine}, exit code ${v.exitCode}`;
    lines.push(`${head} (audit ${v.audit}). The command printed:`, '```', String(v.output ?? '').trimEnd(), '```');
  }
  for (const [k, v] of Object.entries(answer.values)) {
    if (card.privileged?.includes(k)) continue;
    if (access.has(k) && !isSealed(v)) continue;
    if (card.questions?.length && /^q\d+(_comment)?$/.test(k)) continue;
    if (card.approvals?.length && /^approval_\d+$/.test(k)) continue;
    // A sealed secret is never written out: the session opens it into a grant in memory.
    if (isSealed(v)) { lines.push(`${k}: (sealed)`); continue; }
    // A check box or switch group answers with each item on or off, by the item names the agent gave.
    const on = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).filter((x) => (v as Record<string, unknown>)[x]) : undefined;
    const label = on ? on.join(', ') || '(none turned on)'
      : k === 'choice' && card.options
        ? [v].flat().map((x) => card.options?.find((o) => (o.id ?? o.label) === x)?.label ?? String(x)).join(', ')
        : [v].flat().join(', ');
    lines.push(`${k}: ${label}`);
  }
  if (answer.comment) lines.push(`Comment: ${answer.comment}`);
  // Pasted images are files: name each path, or say how many came when the integration has not saved them.
  const images = answer.images ?? [];
  if (imagePaths?.length) images.forEach((f, i) => lines.push(`Image${f.field ? ` pasted in ${f.field}` : ''}: ${imagePaths[i] ?? f.name}`));
  else if (images.length) lines.push(`${images.length} pasted image${images.length === 1 ? '' : 's'}`);
  // Each widget on the card can add text for the agent, filled from this answer, such as what to do next.
  for (const r of answer.responses ?? []) lines.push('', r);
  return lines.join('\n') || 'An empty answer: the person sent nothing more.';
}
