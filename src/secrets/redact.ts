// Masks the values a session holds in text a model is about to read, such as a command's output. A value reaches the
// output when a command prints it, and the model then reads `[secret NAME]` in its place. Unmasking is an explicit act
// outside the session, as `op run` does it.

/** A value shorter than this is left alone: masking every "1" or "ab" in an output would make it unreadable. */
export const MIN_MASKED = 4;

export class Redactor {
  /** name -> every value this session held under that name. A grant that ends keeps its value masked. */
  private readonly values = new Map<string, Set<string>>();

  add(name: string, value: string): void {
    if (value.length < MIN_MASKED) return;
    const held = this.values.get(name) ?? new Set<string>();
    held.add(value);
    this.values.set(name, held);
  }

  /** Whether any value is held, so a caller can skip the work on a session that never received one. */
  get empty(): boolean {
    return this.values.size === 0;
  }

  /** `text` with each held value replaced by `[secret NAME]`, the longest value first so a value that contains
   * another one is masked whole. */
  mask(text: string): string {
    if (this.empty || !text) return text;
    const pairs = [...this.values].flatMap(([name, set]) => [...set].map((value) => [value, name] as const));
    pairs.sort((a, b) => b[0].length - a[0].length);
    let out = text;
    for (const [value, name] of pairs) if (out.includes(value)) out = out.split(value).join(`[secret ${name}]`);
    return out;
  }

  /** The length of the longest held value, which is how much of a stream's tail may still begin one. */
  get longest(): number {
    let n = 0;
    for (const set of this.values.values()) for (const v of set) n = Math.max(n, v.length);
    return n;
  }

  /** The largest index at or before `cut` where no held value straddles, so `text.slice(0, i)` masks whole. */
  safeCut(text: string, cut: number): number {
    let at = cut;
    for (let moved = true; moved;) {
      moved = false;
      for (const set of this.values.values()) {
        for (const v of set) {
          // The occurrences `mask` replaces, left to right and never overlapping, so a value such as `aaaa` in a run of
          // `a`s moves the cut back by less than its own length rather than to the start.
          for (let i = text.indexOf(v); i !== -1 && i < at; i = text.indexOf(v, i + v.length)) {
            if (i + v.length > at) { at = i; moved = true; }
          }
        }
      }
    }
    return at;
  }

  /** A masker for output that arrives in chunks. */
  stream(): StreamMask {
    return new StreamMask(this, () => this.longest);
  }

  /** Every string inside `value`, masked, with the same shape. A tool result is often an object of strings. */
  maskDeep<T>(value: T): T {
    if (this.empty) return value;
    if (typeof value === 'string') return this.mask(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.maskDeep(v)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.maskDeep(v)])) as T;
    }
    return value;
  }
}

/**
 * A masker for output that arrives in chunks, such as a command's stdout. A value may straddle two chunks, so the
 * tail that could still begin a value waits for the next chunk, and `end` gives it back masked.
 */
export class StreamMask {
  private buf = '';
  private readonly redactor: Redactor;
  private readonly longest: () => number;

  constructor(redactor: Redactor, longest: () => number) {
    this.redactor = redactor;
    this.longest = longest;
  }

  push(text: string): string {
    this.buf += text;
    const hold = Math.max(0, this.longest() - 1);
    let cut = this.buf.length - hold;
    if (cut <= 0) return '';
    cut = this.redactor.safeCut(this.buf, cut);
    const out = this.redactor.mask(this.buf.slice(0, cut));
    this.buf = this.buf.slice(cut);
    return out;
  }

  end(): string {
    const out = this.redactor.mask(this.buf);
    this.buf = '';
    return out;
  }
}
