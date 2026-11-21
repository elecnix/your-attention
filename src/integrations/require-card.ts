// The rule that a session must hold an open card, as an integration sees it.
//
// The inbox holds the rule, so a change reaches a running session without a restart. A value in the environment is the
// other way to set it, and it decides for the whole session: the session never reads the inbox again, so nothing there
// can mix with it. Starting the session without the value hands it back to the inbox.
import { DEFAULT_CARD_DELAYS, delaysFromReminders } from '../core/require-card.ts';

/** Whether a session is asked for a card, and at which minutes of inactivity. */
export interface CardRule {
  on: boolean;
  delays: number[];
}

/** The states in which a session's card stands for the card the rule asks for: open, or posted and held by triage.
 * A card a triage hook holds is still the session's question, and asking again would post it twice. */
export const CARD_HELD_STATES: readonly string[] = ['open', 'in-triage', 'held'];

/** Whether one of these cards is the session's card that the rule asks for. */
export function holdsCard(results: readonly { card: { agent?: string }; state: string }[], agent: string): boolean {
  return results.some((c) => c.card.agent === agent && CARD_HELD_STATES.includes(c.state));
}

/** What both harnesses say when they ask, so they ask in one voice. */
export const NO_CARD = '[your-attention] This session has no open card. Post one with card_post that says what you are working on and what you need from the person.';

/**
 * The rule the environment sets, or undefined when this session takes the inbox's rule. Any value counts as a
 * decision: `1` asks for a card on the default schedule and anything else does not, which is how
 * `YOUR_ATTENTION_REQUIRE_CARD=0` turns the rule off for one session of an inbox that asks everyone.
 */
export function envRequireCard(env: Record<string, string | undefined>): CardRule | undefined {
  const forced = env['YOUR_ATTENTION_REQUIRE_CARD'];
  if (forced === undefined) return undefined;
  return { on: forced === '1', delays: [...DEFAULT_CARD_DELAYS] };
}

/** The rule one session obeys: the environment when it says anything, and the inbox's value otherwise. */
export function resolveRequireCard(env: Record<string, string | undefined>, fromInbox: CardRule): CardRule {
  return envRequireCard(env) ?? fromInbox;
}

/** The rule from the inbox's answer. An inbox from before the schedule sends only a count, which maps to its delays. */
export function ruleFromView(view: { on: boolean; delays?: number[]; reminders?: number }): CardRule {
  return { on: view.on, delays: Array.isArray(view.delays) ? view.delays : delaysFromReminders(Number(view.reminders ?? DEFAULT_CARD_DELAYS.length)) };
}

/** How long one minute of the schedule lasts: a minute, unless a test shortens it. */
export function minuteMs(env: Record<string, string | undefined>): number {
  const ms = Number(env['YOUR_ATTENTION_CARD_ASK_MINUTE_MS']);
  return ms > 0 ? ms : 60_000;
}
