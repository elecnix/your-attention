export interface SettingsWrites {
  /** Send one write after every earlier write settled. The promise settles as the write does. */
  save(patch: Record<string, unknown>): Promise<unknown>;
  /** Mark the start of a state request. Pass the number it returns to `settingsCurrent` and `newest` once the state arrives. */
  started(): number;
  /** True when the state of that request holds settings no older than this client's own writes. */
  settingsCurrent(started: number): boolean;
  /** True when no state of a later request has been applied. A client whose state requests overlap drops a state that answers false. */
  newest(started: number): boolean;
}

/** Order a client's settings writes and the states it reads. `send` performs one write and settles when the inbox answers. */
export function settingsWrites(send: (patch: Record<string, unknown>) => Promise<unknown>): SettingsWrites;
