/** A candidate as card_post fills it, made up for the stories and tests. */
type StoryCandidate = { id: string; label: string; source: string; instance: string; store?: string; type?: string; host?: string; status?: string; reason?: string };
export const DATABASE_URL: StoryCandidate[];
export const OPENAI_API_KEY: StoryCandidate[];
/** The fields of a card that asks for two secrets. */
export const SEVERAL: { name: string; candidates: StoryCandidate[] }[];
/** A body with one SecretAccess field per entry of `fields`, sealed to `publicKey`. */
export function accessBody(fields: { name: string; candidates: unknown[] }[], intro?: string, publicKey?: JsonWebKey): string;
/** A card that asks for each of `fields`, with the card's `secrets`. */
export function accessCard(fields: { name: string; candidates: unknown[] }[], over?: Record<string, unknown>): { body: string; secrets: string[] };
