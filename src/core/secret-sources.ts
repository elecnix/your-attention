// The inbox's side of secret sources: what a lookup answers and what a grant stores. The sources themselves run in a
// platform process, the laptop's `serve`, which hands the inbox a SecretSources. SPEC.md#secret-sources holds the contract.
import type { Sealed } from './types.ts';

/** What an agent may ask for. A query with no field matches nothing. */
export interface SecretQuery {
  name?: string;
  type?: string;
  host?: string;
}

/** One secret a source can release, as metadata. A candidate never holds its value. */
export interface SourceCandidate {
  /** Unique within its source. */
  id: string;
  label: string;
  store?: string;
  type?: string;
  host?: string;
  /** When the secret last changed, in milliseconds. */
  changedAt?: number;
}

/** A candidate as the inbox answers it, with the source and the instance that hold it. */
export interface Candidate extends SourceCandidate {
  source: string;
  instance: string;
}

export type SourceStatus = 'ready' | 'off' | 'error';

/** A source as `GET /v1/secrets/sources` lists it. Never its settings. */
export interface SourceInfo {
  instance: string;
  name: string;
  builtin: boolean;
  status: SourceStatus;
  /** Why the source is off or failed, for the person. */
  reason?: string;
}

/** The sources an inbox reaches. The hosted inbox has none in version 1. */
export interface SecretSources {
  list(): Promise<SourceInfo[]>;
  lookup(query: SecretQuery): Promise<{ candidates: Candidate[]; sources: SourceInfo[] }>;
  /** Seal the candidate's value to `publicKey` inside the source. Throws with a sentence for the person. */
  release(source: string, candidate: string, publicKey: JsonWebKey): Promise<Sealed>;
}

/** What the page answers for a secret_access field. */
export type AccessChoice =
  | { grant: string; source: string; instance: string; until: number }
  | { decline: true };

/** What the inbox stores for a granted secret_access field, and what the agent stream carries. */
export interface AccessGrant {
  grant: string;
  source: string;
  instance: string;
  /** The ceiling, in milliseconds. Use never pushes it later. */
  until: number;
  /** A short id for this grant, which the person and the agent quote. */
  case: string;
  sealed: Sealed;
  revokedAt?: number;
}

/** The idle window of a grant: each use restarts it. The session's grant store records the last use and applies this
 * window, since only the session sees each use. The inbox stores the ceiling, `until`, alone. */
export const GRANT_IDLE_MS = 15 * 60_000;
/** The ceiling a card offers by default, and the most a card may ask for. */
export const GRANT_DEFAULT_MS = 60 * 60_000;
export const GRANT_MAX_MS = 24 * 60 * 60_000;
