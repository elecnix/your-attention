// Opens the herdr pane a card came from. It moves focus only: no keys reach the agent.
import { execFile } from 'node:child_process';
import type { Card } from '../../core/types.ts';

export function focusHerdrPane(card: Card): Promise<void> {
  const pane = card.origin?.herdrPane;
  if (!pane || !/^[\w:]+$/.test(pane)) return Promise.reject(new Error('the card has no herdr pane'));
  return new Promise((resolve, reject) => {
    execFile(process.env['HERDR_BIN_PATH'] ?? 'herdr', ['agent', 'focus', pane], (err) => (err ? reject(err) : resolve()));
  });
}
