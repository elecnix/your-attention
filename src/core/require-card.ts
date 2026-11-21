// The schedule of the rule that a session must hold an open card: the minutes of inactivity at which it is asked.

/** The minutes at which an inactive session with no open card is asked for one, counted from when it went inactive. */
export const DEFAULT_CARD_DELAYS: readonly number[] = [2, 5, 10];
/** The most asks one stretch can have. */
export const MAX_CARD_DELAYS = 10;
/** The longest delay, in minutes: one day. */
export const MAX_DELAY_MINUTES = 1440;
/** The highest count the older `reminders` field takes. It is read for one release, then dropped. */
export const MAX_REMINDERS = 10;

/**
 * The schedule an older `reminders` count stands for: the first n default delays. The default has three, so a count
 * above three asks three times, at 2, 5 and 10 minutes, and 0 never asks.
 */
export function delaysFromReminders(n: number): number[] {
  return DEFAULT_CARD_DELAYS.slice(0, Math.max(0, n));
}

/** Why a value cannot be a schedule, or undefined when it can. */
export function delaysProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return 'delays must be a list of minutes';
  if (value.length > MAX_CARD_DELAYS) return `delays takes at most ${MAX_CARD_DELAYS} entries`;
  for (const [i, d] of value.entries()) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > MAX_DELAY_MINUTES) return `delays takes whole minutes from 1 to ${MAX_DELAY_MINUTES}`;
    if (i > 0 && d <= (value[i - 1] as number)) return 'delays must go up: each one later than the one before';
  }
  return undefined;
}

/** The schedule in words, such as "after 2, 5 and 10 minutes of inactivity". */
export function describeDelays(delays: readonly number[]): string {
  if (!delays.length) return 'never';
  const minutes = delays.length === 1 ? String(delays[0]) : `${delays.slice(0, -1).join(', ')} and ${delays[delays.length - 1]}`;
  return `after ${minutes} minute${delays.length === 1 && delays[0] === 1 ? '' : 's'} of inactivity`;
}
