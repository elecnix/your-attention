import type { Answer, Card } from '../src/core/types.ts';
/** OpenUI Lang for a card: its own body with the page's answer footer, or a form built from its options and questions. */
export function cardSource(card: Card): string;
/** The statements of OpenUI Lang source, by name. */
export function parseSource(source: string | undefined): Record<string, { call: string; args: unknown[] }>;
/** The picks the card still offers, by option id. */
export function answerValues(card: Card, values: Record<string, unknown>): Record<string, unknown>;
/** Form values by field name, and the comments joined, from the renderer's state: {form: {field: {value}}}. */
export function formValues(formState: unknown): { values: Record<string, unknown>; comment: string };
/** An answer as a person reads it. */
export function describe(card: Card, answer: Answer | undefined): string;
/** Every revision, newest first: for each one, the lines it removed and added in each field. */
export function changeSteps(card: Card): { version: number; fields: { label: string; removed: string[]; added: string[] }[] }[];
/** A pick's value: the option's id and its label. */
export function optionValue(option: { id: string; label: string }): string;
/** Whether a recommendation starts with this label, then a sentence end, a comma, a colon or the end of the text. */
export function recommendationNames(recommendation: string | undefined, label: string): boolean;
/** The ids of the options a card recommends, and whether its recommendation goes inside the one it recommends. */
export function recommendedOptions(card: Pick<Card, 'options'> & Partial<Card>): { ids: string[]; inside: boolean };
