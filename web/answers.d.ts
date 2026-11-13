import type { Answer, Card } from '../src/core/types.ts';
/** The tooltip and accessible label of the icon button that dismisses a card, which sits at the end of its buttons row. */
export const DISMISS: string;
/** OpenUI Lang for a card: its own body with the page's answer footer, or a form built from its options and questions. */
export function cardSource(card: Card): string;
/** The statements of OpenUI Lang source, by name. */
export function parseSource(source: string | undefined): Record<string, { call: string; args: unknown[] }>;
/** The picks the card still offers, by option id. */
export function answerValues(card: Card, values: Record<string, unknown>): Record<string, unknown>;
/** The answer text for a card's questions: a line per question with its answer, and an indented line per comment. */
export function questionLines(card: Pick<Card, 'questions'>, values: Record<string, unknown>): string[];
/** The options each question recommends, by field name, such as {q0: ['SQLite']}. */
export function questionRecommendations(card: Pick<Card, 'questions'>): Record<string, string[]>;
/** Form values by field name, and the comments joined, from the renderer's state: {form: {field: {value}}}. */
export function formValues(formState: unknown): { values: Record<string, unknown>; comment: string };
/** An answer as a person reads it. */
export function describe(card: Card, answer: Answer | undefined): string;
/** Every revision, newest first: for each one, the lines it removed and added in each field. */
export function changeSteps(card: Card): { version: number; fields: { label: string; removed: string[]; added: string[] }[] }[];
/** The name a pick and the page's lookups use for an option: its id, or its label when it has none. */
export function optionId(option: { id?: string; label: string }): string;
/** A pick's value: the option's id and its label. */
export function optionValue(option: { id?: string; label: string }): string;
/** Whether a recommendation starts with this label, then a sentence end, a comma, a colon or the end of the text. */
export function recommendationNames(recommendation: string | undefined, label: string): boolean;
/** The ids of the options a card recommends, and whether its recommendation goes inside the one it recommends. */
export function recommendedOptions(card: Pick<Card, 'options'> & Partial<Card>): { ids: string[]; inside: boolean; text: string };
/** The recommendation without the label it starts with, capitalized, or as it is when it does not start with the label. */
export function recommendationRest(recommendation: string | undefined, label: string): string;
/** The words of a removed line and of the added line that replaced it, each marked changed or not, or null when they share no word. */
export function wordDiff(before: string, after: string): { del: [string, boolean][]; add: [string, boolean][] } | null;
/** One line of a guidance diff: unchanged, removed or added, with its words marked when it pairs with a changed line. */
export interface GuidanceRow { kind: 'same' | 'del' | 'add'; text: string; words?: [string, boolean][]; undone?: boolean }
/** The proposed guidance against the current one, line by line in order. With `base`, a removed line the proposal never saw is `undone`. */
export function guidanceDiff(current: string, proposed: string, base?: string): GuidanceRow[];
