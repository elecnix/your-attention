// A JSON Lines log of every ruling the example triage agent gives: one line per card the hook answers, so the
// operator can look back at which check bounced which card, and how the PR-verdict command scored a pull request.
// checkCard builds each line from the ruling it is about to return, so the line and the ruling cannot drift apart.
// The file is mode 0600 and its directory 0700, as the state file is. Past MAX_LOG_BYTES the file rotates to
// `<logFile>.1`, replacing an earlier one, so disk use stays bounded. A write that fails never changes a ruling:
// the agent logs why on standard error and carries on.
import fs from 'node:fs';
import path from 'node:path';

/** The most the log grows before it rotates to `<logFile>.1`. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** One check's part of a ruling line: its name, the sections it wrote, why it skipped when it did, and its detail. */
export interface LoggedCheck {
  name: string;
  sections: { level: 'block' | 'advise'; lines: string[] }[];
  skipped?: string;
  detail?: unknown;
}

/** One ruling, as one line. `pr` and `bypass` appear only when the card gives them. */
export interface RulingLine {
  at: string;
  card: { id: string; agent: string; title: string; tags: Record<string, string> };
  pr?: string;
  checks: LoggedCheck[];
  verdict: 'pass' | 'return';
  reason: string;
  advice?: string;
  returns: { count: number; max: number };
  bypass?: { used: true; issuedFor: string } | { used: false; why: string };
  ms: number;
}

/** Append one line, rotating first when the line would take the file past MAX_LOG_BYTES. Throws what fs throws. */
export function appendLine(file: string, line: RulingLine): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(line)}\n`;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch { /* the file does not exist yet */ }
  if (size > 0 && size + Buffer.byteLength(text) > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  fs.appendFileSync(file, text, { mode: 0o600 });
}

/** Append one ruling line. A failure writes one line to `log` and changes nothing else. */
export function logRuling(file: string, line: RulingLine, log: (...a: unknown[]) => void): void {
  try {
    appendLine(file, line);
  } catch (e) {
    log(`could not write the rulings log ${file} (${(e as Error).message}), so this ruling is not in it`);
  }
}
