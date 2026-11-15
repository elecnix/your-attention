// The rule that a session must hold an open card, as an integration sees it.
//
// The inbox holds the rule, so a change reaches a running session without a restart. A value in the environment is the
// other way to set it, and it decides for the whole session: the session never reads the inbox again, so nothing there
// can mix with it. Starting the session without the value hands it back to the inbox.

/** Whether a session is asked for a card, and how many times one stretch without a card is asked about. */
export interface CardRule {
  on: boolean;
  reminders: number;
}

/** How many times a session is asked when the environment sets the rule: the inbox's count does not apply to it. */
export const ENV_REMINDERS = 3;

/**
 * The rule the environment sets, or undefined when this session takes the inbox's rule. Any value counts as a
 * decision: `1` asks for a card and anything else does not, which is how `YOUR_ATTENTION_REQUIRE_CARD=0` turns the
 * rule off for one session of an inbox that asks everyone.
 */
export function envRequireCard(env: Record<string, string | undefined>): CardRule | undefined {
  const forced = env['YOUR_ATTENTION_REQUIRE_CARD'];
  if (forced === undefined) return undefined;
  return { on: forced === '1', reminders: ENV_REMINDERS };
}

/** The rule one session obeys: the environment when it says anything, and the inbox's value otherwise. */
export function resolveRequireCard(env: Record<string, string | undefined>, fromInbox: CardRule): CardRule {
  return envRequireCard(env) ?? fromInbox;
}
