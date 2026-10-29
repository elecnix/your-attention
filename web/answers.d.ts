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
