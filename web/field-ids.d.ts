import type { Answer, Card } from '../src/core/types.ts';

/** One form, field or option of a card at one version. A form has no `form`; an option names its field's ID in `field`. */
export interface FieldId {
  id: string;
  form?: string;
  field?: string;
  name: string;
  kind: 'form' | 'option' | 'choice' | 'text' | 'number' | 'date' | 'secret' | 'access' | 'action' | 'approval' | 'comment';
}

/** The ID of one value or of the comment of an answer. */
export interface AnswerFieldId {
  id: string;
  form?: string;
  name: string;
  kind: FieldId['kind'];
}

/** Characters per ID. */
export const ID_CHARS: number;
/** The ID of one set of hash inputs. */
export function shortId(parts: string[]): string;
/** Every form, field and option of a card at its version, in the order the page draws them. */
export function cardFields(card: Card): FieldId[];
/** The card as it was at one version, as far as its history holds it. */
export function cardAt(card: Card, version: number | undefined): Card;
/** The ID of each value and of the comment of an answer, and `stale` when it answered a version the card has left. */
export function answerFields(card: Card, answer: Pick<Answer, 'values' | 'comment'> & { version?: number }): {
  version: number;
  fields: AnswerFieldId[];
  stale?: { answered: number; current: number; unknown: string[] };
};
/** The IDs of a card as an agent reads them, a line per form. */
export function describeFields(fields: FieldId[]): string;
