// A pi session waiting on a prompt that some extension drew in the terminal: one blocked card for each prompt span,
// closed when the span ends, and an answer on the card typed into the session's own herdr pane.
//
// The block comes from pi's own lifecycle, not from reading the screen. `ui_prompt_start` reports a session that
// waits even while its pane draws nothing new, and `ui_prompt_end` reports that it stopped. pi coalesces nested or
// overlapping prompts into one outer span, so a nested prompt never posts a second card.
import type { Client } from '../../client.ts';
import { randomId } from '../../core/crypto.ts';
import type { Answer, Card, CloseKind, NewCard } from '../../core/types.ts';
import { runHerdr } from '../herdr/approve.ts';
import { type Herdr, trimScreen } from '../herdr/blocked.ts';
import { herdrPlace } from '../herdr/place.ts';

const log = (...a: unknown[]): void => console.error('[your-attention]', ...a);

const PANE = /^[\w:]+$/;

/** A prompt span as pi reports it. `ui_prompt_start` carries the widget and the prompt's title; `ui_prompt_end`
 * carries the same pair for the span it closes. */
export interface PromptEvent {
  /** The widget that waits: pi's `select`, `confirm`, `input`, `editor` or `custom`. */
  kind?: string;
  /** The prompt's own title, when the extension that drew it gave one. */
  title?: string;
}

/** The session a prompt card belongs to, as the extension knows it once the session started. */
export interface PromptSession {
  inbox: Client;
  agent: string;
  origin: NewCard['origin'];
}

export interface PromptCards {
  /** A prompt span opened: post its one card and keep it until the span ends. */
  started(event: PromptEvent): Promise<void>;
  /** The span ended because the terminal answered the prompt: close the card as answered in the terminal. */
  ended(): Promise<void>;
  /** The session ended with a prompt open: close the card, since no answer can reach that session. */
  shutdown(): Promise<void>;
  /** Whether this answer belongs to a prompt card, so this extension types it instead of the model reading it. */
  owns(card: string): boolean;
  /** Type the answer into the session's own pane, when the same prompt still waits there. */
  answered(card: Card, answer: Answer): Promise<void>;
}

/** One prompt span, with the card that reports it. */
interface Span {
  inbox: Client;
  /** The id the card posts under, chosen before the post so a span that ends during it knows what to close. */
  id: string;
  /** The card the span reports, once the post has returned. */
  card?: Card;
  /** The prompt's kind and title, so the card it leaves behind can be matched to the span that follows it. */
  kind: string;
  title?: string;
  /** The screen the card shows, which is how a prompt with no title is recognised on the pane. */
  screen?: string;
  /** The pane this session runs in, when it has one. */
  pane?: string;
  /** Set once nothing more can be typed: the extension typed the answer, the card closed, or an answer was refused. */
  closed?: 'typed' | 'ended' | 'refused';
  /** Set while this extension types an answer, so a second answer is refused instead of typed into the pane as well. */
  typing?: boolean;
  /** The close the span asked for while its card was still being posted, run once the card exists. */
  late?: { kind: CloseKind; outcome: string };
}

/** The session as a card names it: the name the launcher gave it, with the id beside it, or the id alone. */
export function sessionName(origin: NewCard['origin']): string {
  const name = origin?.name?.trim();
  const id = origin?.session?.trim();
  if (name && id && name !== id) return `${name} (${id})`;
  return name || id || 'This pi session';
}

/** The card's title, the way herdr-blocked titles the card of a pane that waits. */
export function promptTitle(origin: NewCard['origin']): string {
  return `${origin?.name?.trim() || origin?.session?.trim() || 'A pi session'} is waiting for you`;
}

/** What the card says: the session that waits, the prompt's kind and its title, and where the person can answer it. */
export function promptText(origin: NewCard['origin'], prompt: PromptEvent, pane: string | undefined): string {
  const kind = prompt.kind?.trim() || 'ui';
  const title = prompt.title?.trim();
  const asked = title ? `the ${kind} prompt: "${title}"` : `the ${kind} prompt`;
  const answer = pane
    ? 'Answer it in the terminal, or type an answer on this card and this extension types it into the pane.'
    // The protocol cannot fill a prompt in a session with no pane, so the card says so rather than offering an answer.
    : 'This session runs outside a herdr pane, so an answer on this card cannot reach it. Answer it in the terminal.';
  return `${sessionName(origin)} is waiting at ${asked}.\n\n${answer}`;
}

/** What the person typed on the card: the comment, or the first value when the answer carries the text there. */
export function typedAnswer(answer: Answer): string {
  const comment = answer.comment.trim();
  if (comment) return comment;
  for (const value of Object.values(answer.values)) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

/** The row a frame closes on: the rule that ends the screen. A prompt that waits draws its box last on the pane, so
 * that row belongs to the prompt alone, and a session that resumed writes its output below the frame it left behind.
 * The words inside the box change as the answer is typed into it, and the rule below them does not. */
function closingRule(screen: string): string {
  const rows = screen.split('\n').filter((l) => l.trim());
  const foot = rows[rows.length - 1] ?? '';
  return /[─━═]/.test(foot) && !/[A-Za-z0-9]/.test(foot) ? foot : '';
}

const TOP_CORNER = /[\u250c-\u250f\u2552-\u2554\u256d]/;

/** The shape of the frame that ends a screen: every row from its top corner to the closing rule, reduced to the box
 * drawing characters it draws and nothing else. Text typed into the box leaves the shape alone, whatever it contains,
 * so an answer still finds its prompt, while a box of another height, width or set of corners has a shape of its own. Comparing every row is what keeps a nested prompt
 * from passing for the one outside it: pi folds the two spans into one, so the inner frame can replace the outer. */
function frameShape(screen: string): string[] {
  const rows = screen.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  let top = -1;
  rows.forEach((l, i) => {
    if (TOP_CORNER.test(l)) top = i;
  });
  return top < 0 ? [] : rows.slice(top).map((l) => l.replace(/[^\u2500-\u257f]/g, ''));
}

/** Whether the prompt a card was posted for still waits on the screen just read. pi gives a title for every widget
 * except a custom screen, and a changed prompt loses that title; a prompt with no title has only the frame it draws,
 * and the screen it draws ends on that frame. A frame that stays painted above an agent's new output is a prompt
 * that ended, and a frame of another shape is another prompt. */
export function promptOnScreen(prompt: { title?: string; screen?: string }, raw: string): boolean {
  const now = trimScreen(raw);
  if (!now) return false;
  const title = prompt.title?.trim();
  if (title) return now.includes(title);
  if (closingRule(now) === '') return false;
  const then = frameShape(prompt.screen ?? '');
  const drawn = frameShape(now);
  return then.length > 0 && drawn.length === then.length && then.every((row, i) => row === drawn[i]);
}

/** Why no key goes out, when the screen no longer shows the prompt the card was posted for. */
function lostPrompt(prompt: { title?: string; screen?: string }): string {
  return prompt.title?.trim()
    ? 'The prompt changed or closed before your answer arrived, so nothing was typed. Answer it in the terminal.'
    : 'This prompt has no title, and the frame it draws no longer ends the screen, so nothing was typed. Answer it in the terminal.';
}

const paneOf = (pane: string | undefined): string | undefined => (pane && PANE.test(pane) ? pane : undefined);

/**
 * The prompt cards of one session. `session` reads the connected session, and is undefined until `session_start`
 * has run; `herdr` runs one herdr command, so a test can stand in for the terminal.
 */
export function createPromptCards(session: () => PromptSession | undefined, herdr: Herdr = runHerdr, settleMs = 600): PromptCards {
  // The span pi reports as open. pi coalesces nested prompts, so one span is open at a time.
  let span: Span | undefined;
  // The card the last span ended with. A prompt that flickers and comes back is a new version of that card.
  let last: { id: string; kind: string; title?: string } | undefined;
  // The cards this session posted for prompts, so an answer that arrives after its span ended is refused rather than
  // read as a message for the model. Every id is kept for the life of the session: any bound small enough to reach
  // would hand an older card's answer to the model, and one id costs a few bytes.
  const posted = new Set<string>();
  // The last inbox seen, which a late answer still needs to record its refusal.
  let inbox: Client | undefined;

  const read = async (pane: string): Promise<string> =>
    herdr('pane', 'read', pane, '--lines', '60', '--source', 'detection').catch(() => '');

  /** Refuse an answer with the reason on the card: no key goes out, and the person reads why. */
  const refuse = async (to: Client, card: Card, why: string): Promise<void> => {
    if (span?.card?.id === card.id) span.closed ??= 'refused';
    await to.ack(card.id).catch(() => {});
    await to.close(card.id, 'resolved', why).catch(() => {});
    log('no key for', card.id, why);
  };

  /** Record an answer that changes nothing, with the reason on stderr: the card belongs to the answer already on its
   * way into the pane, so a second answer leaves its outcome alone. */
  const note = async (to: Client, card: Card, why: string): Promise<void> => {
    await to.ack(card.id).catch(() => {});
    log('no key for', card.id, why);
  };

  /** Post the span's card, resolving to undefined when the inbox refuses it, whether it rejects or throws as it is
   * called, so the start settles and no span keeps a card that never arrives. */
  const postCard = async (to: Client, card: NewCard): Promise<Card | undefined> => {
    try {
      return await to.post(card);
    } catch (e) {
      log('could not post the prompt card:', (e as Error).message);
      return undefined;
    }
  };

  /** Close a span's card now, or keep the close for the post that is still on its way. */
  const closeSpan = async (open: Span, kind: CloseKind, outcome: string): Promise<boolean> => {
    if (!open.card) {
      open.late = { kind, outcome };
      return false;
    }
    await open.inbox.close(open.card.id, kind, outcome).catch((e: Error) => log('could not close', open.id, e.message));
    return true;
  };

  return {
    async started(event) {
      const connected = session();
      if (!connected) return;
      // A span is already open: pi reported a nested prompt as part of it, and that one card is the card.
      if (span && !span.closed) return;
      inbox = connected.inbox;
      const kind = event.kind?.trim() || 'ui';
      const title = event.title?.trim();
      const pane = paneOf(connected.origin?.herdrPane);
      const id = last && last.kind === kind && last.title === title ? last.id : `prompt-${randomId(4)}`;
      // The span goes on record before the first await, so a prompt that ends while the pane is read and the card is
      // posted is still closed: the card closes as soon as it exists, rather than staying open with nothing left to
      // close it.
      const open: Span = { inbox: connected.inbox, id, kind, title, pane };
      span = open;
      const raw = pane ? await read(pane) : '';
      const screen = raw ? trimScreen(raw) : '';
      open.screen = screen || undefined;
      // A blocked card takes no `deliver: 'none'`, or the inbox would keep the answer from the one integration that
      // can type it. The extension reads the answer on the session's stream and never passes it to the model.
      const card = await postCard(connected.inbox, {
        id,
        agent: connected.agent,
        kind: 'blocked',
        title: promptTitle(connected.origin),
        text: promptText(connected.origin, event, pane),
        priority: 'now',
        ...(screen ? { screen } : {}),
        origin: { ...connected.origin, ...(await herdrPlace(pane, herdr)) },
        // The prompt's labels never reach this extension, so the card offers no options, and the person answers in the
        // terminal or types an answer that the extension forwards.
      });
      if (!card) {
        if (span === open) span = undefined;
        return;
      }
      open.card = card;
      posted.add(id);
      // The span ended while its card was being posted, so nothing else will close the card. A card that a later span
      // took over stays open, since a prompt that comes back is the same one with its card still up.
      if (open.late && span?.id !== open.id) await closeSpan(open, open.late.kind, open.late.outcome);
      log('card', id, 'for a', kind, 'prompt');
    },

    async ended() {
      const open = span;
      if (!open) return;
      span = undefined;
      // The same prompt that comes back keeps its card, with a new version, rather than posting a second one.
      last = { id: open.id, kind: open.kind, title: open.title };
      if (open.closed) return;
      open.closed = 'ended';
      if (await closeSpan(open, 'answered-in-terminal', 'Answered in the terminal.')) log('closed', open.id, 'as answered in the terminal');
    },

    async shutdown() {
      const open = span;
      span = undefined;
      if (!open || open.closed) return;
      open.closed = 'ended';
      await closeSpan(open, 'resolved', 'The session ended with this prompt open.');
    },

    owns(card) {
      return span?.card?.id === card || posted.has(card);
    },

    async answered(card, answer) {
      const to = inbox;
      if (!to) return;
      const open = span?.card?.id === card.id ? span : undefined;
      if (!open) return refuse(to, card, 'The prompt closed before your answer arrived, so nothing was typed. Answer it in the terminal.');
      if (open.closed === 'typed') return refuse(to, card, 'Your answer was already typed into its session, so nothing more was sent.');
      // The card is marked as being answered before the first await, so a second answer that arrives while this one
      // reads the pane and sends keys sends nothing, instead of typing the same words into the session twice. It
      // closes nothing either: the card reports the answer already on its way, not the one that arrived beside it.
      if (open.typing) return note(to, card, 'An answer on this card is already being typed into its session, so nothing more was sent.');
      if (open.closed) return refuse(to, card, 'The prompt ended before your answer arrived, so nothing was typed.');
      const text = typedAnswer(answer);
      if (!text) return refuse(to, card, 'The answer was empty, so nothing was typed. Type the answer in the terminal.');
      if (!open.pane) return refuse(to, card, 'This session has no herdr pane, so the answer was not typed. Answer it in the terminal.');
      open.typing = true;
      // The pane is read again immediately before a key goes out: a prompt that changed or closed gets no keystroke,
      // because a keystroke sent to a working agent would interrupt it.
      if (!promptOnScreen(open, await read(open.pane))) {
        open.typing = false;
        return refuse(to, card, lostPrompt(open));
      }
      try {
        await herdr('agent', 'send-keys', open.pane, text);
      } catch (e) {
        open.typing = false;
        return refuse(to, card, `herdr could not type into the pane: ${(e as Error).message}. Answer it in the terminal.`);
      }
      // Some prompts take the typed text alone, and others need Enter to accept it. Confirm only while the same prompt
      // still waits, the way herdr-blocked presses Enter for a number that only moved the selection. A prompt that is
      // gone from the screen gets no Enter, and the card says so, since a key sent to a working agent would interrupt it.
      await new Promise((r) => setTimeout(r, settleMs));
      // The span can end during the settle, and the prompt that follows it reuses this card. That card belongs to the
      // span now waiting, so this answer types no Enter into it and leaves it open: the close below goes only to the
      // span that was answered.
      const mine = span === open;
      open.closed ??= 'typed';
      const waits = mine && promptOnScreen(open, await read(open.pane));
      await to.ack(card.id).catch(() => {});
      // The span can also end during that acknowledgement, which is a round trip to the inbox: re-read it here, or a
      // prompt that ended inside that window takes an Enter it no longer needs. A later span that holds this card keeps
      // it, and any other card closes, since the answer did reach the pane of the span it belongs to.
      if (span !== open) {
        // A span knows its id before its post returns, so the id, not the card, is what says a later span took this one.
        if (span?.id === card.id) return log('typed the answer for', card.id, 'into', open.pane, 'as its span ended');
        await to.close(card.id, 'resolved', 'Typed your answer in its session.').catch(() => {});
        return log('typed the answer for', card.id, 'into', open.pane, 'as its span ended');
      }
      if (waits) await herdr('agent', 'send-keys', open.pane, 'enter').catch(() => {});
      await to.close(card.id, 'resolved', waits
        ? 'Typed your answer in its session.'
        : 'Typed your answer in its session, without Enter: the prompt was not on the screen to confirm it.').catch(() => {});
      log('typed the answer for', card.id, 'into', open.pane);
    },
  };
}
