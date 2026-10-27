import type { Sealed } from '../src/core/types.ts';
export function seal(publicJwk: JsonWebKey, text: string): Promise<Sealed>;
