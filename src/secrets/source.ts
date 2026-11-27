// A secret source plugin, in either form version 1 runs: a Node module the process imports, or an executable that
// speaks the stdio messages below. SPEC.md#secret-sources holds the contract.
import type { SecretQuery, SourceCandidate } from '../core/secret-sources.ts';
import type { Sealed } from '../core/types.ts';

export type Detected = { status: 'ready' } | { status: 'off'; reason: string };

/** What a Node module source exports, and what the stdio form is adapted to. */
export interface SecretSource {
  detect(): Promise<Detected>;
  /** Only what matches the query, never the whole store. */
  lookup(query: SecretQuery): Promise<SourceCandidate[]>;
  /** The candidate's value, sealed to `publicKey` with sealValue. Throws with a sentence for the person. */
  release(candidate: string, publicKey: JsonWebKey): Promise<Sealed>;
}

/** One line of `~/.your-attention/sources.jsonl`. It stays on its instance. */
export interface SourceEntry {
  kind: 'secret';
  name: string;
  /** A built-in source's entry holds only its settings. */
  builtin?: boolean;
  form?: 'node' | 'stdio';
  /** `file://` only, in version 1. */
  origin?: string;
  /** For the stdio form: the executable and its arguments, relative to the origin's folder. */
  command?: string[];
  settings?: Record<string, unknown>;
}

export const SOURCE_PROTOCOL_VERSION = 1;
/** A call that takes longer fails, and the stdio source starts again on the next one. */
export const SOURCE_CALL_TIMEOUT_MS = 30_000;

/** A request on a stdio source's stdin, one JSON object per line. */
export type SourceRequest =
  | { v: 1; id: string; call: 'detect' }
  | { v: 1; id: string; call: 'lookup'; query: SecretQuery }
  | { v: 1; id: string; call: 'release'; candidate: string; publicKey: JsonWebKey };

/** A reply on its stdout, with the id of the request it answers. */
export type SourceReply =
  | { v: 1; id: string; status: 'ready' }
  | { v: 1; id: string; status: 'off'; reason: string }
  | { v: 1; id: string; candidates: SourceCandidate[] }
  | { v: 1; id: string; sealed: Sealed }
  | { v: 1; id: string; error: string };
