// The PIN questions the CLI asks in a terminal: when `serve` or `start` finds an
// inbox with no PIN, and for `your-attention pin set` and `pin reset`. The PIN is
// typed hidden and never printed.
import readline from 'node:readline';

export interface PinApi {
  status(): Promise<{ set: boolean; neverAsk: boolean; lockedUntil: number | null }>;
  set(pin: string): Promise<void>;
  clear(): Promise<void>;
  neverAsk(): Promise<void>;
}

export interface Terminal {
  ask(question: string): Promise<string>;
  /** A line typed without echo. */
  askHidden(question: string): Promise<string>;
  say(text: string): void;
  close(): void;
}

/** Questions on the terminal. A pipe gives one answer per line, so scripts and tests can answer too. */
export function terminal(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Terminal {
  const piped = !input.isTTY;
  // The pipe is read only once a question needs it, so a command that asks nothing leaves stdin alone.
  let rl: readline.Interface | undefined;
  let lines: AsyncIterator<string> | undefined;
  const next = async (): Promise<string> => {
    rl ??= readline.createInterface({ input, terminal: false });
    lines ??= rl[Symbol.asyncIterator]();
    const r = await lines.next();
    return r.done ? '' : String(r.value);
  };
  return {
    async ask(question) {
      output.write(question);
      if (piped) { const a = await next(); output.write('\n'); return a.trim(); }
      const tty = readline.createInterface({ input, output, terminal: true });
      try { return (await new Promise<string>((r) => tty.question('', r))).trim(); } finally { tty.close(); }
    },
    async askHidden(question) {
      output.write(question);
      if (piped) { const a = await next(); output.write('\n'); return a.trim(); }
      input.setRawMode(true);
      input.resume();
      try {
        return await new Promise<string>((resolve) => {
          let typed = '';
          const onData = (chunk: Buffer): void => {
            for (const ch of chunk.toString('utf8')) {
              if (ch === '\u0003') { input.setRawMode(false); output.write('\n'); process.exit(130); }
              if (ch === '\r' || ch === '\n' || ch === '\u0004') { input.off('data', onData); output.write('\n'); return resolve(typed); }
              if (ch === '\u007f' || ch === '\b') typed = typed.slice(0, -1);
              else if (ch >= ' ') typed += ch;
            }
          };
          input.on('data', onData);
        });
      } finally {
        input.setRawMode(false);
        input.pause();
      }
    },
    say(text) { output.write(`${text}\n`); },
    close() { rl?.close(); },
  };
}

/** Ask for a new PIN twice. An empty answer gives up, and returns undefined. */
export async function choosePin(t: Terminal): Promise<string | undefined> {
  for (let i = 0; i < 3; i++) {
    const pin = await t.askHidden('New PIN, 4 digits (Enter to stop): ');
    if (!pin) return undefined;
    if (!/^\d{4}$/.test(pin)) { t.say('A PIN is 4 digits.'); continue; }
    if ((await t.askHidden('Type it again: ')) === pin) return pin;
    t.say('The two PINs differ.');
  }
  return undefined;
}

/** The question `serve` and `start` ask in a terminal when the inbox has no PIN, until the person sets one or picks "never". */
export async function offerPin(t: Terminal, api: PinApi): Promise<'set' | 'skipped' | 'never' | 'not asked'> {
  const s = await api.status();
  if (s.set || s.neverAsk) return 'not asked';
  t.say('This inbox has no PIN. Anyone who gets its address or a sign-in link can answer your agents\' cards.');
  t.say('With a PIN, each new browser tab asks for it before it opens the inbox.');
  const answer = (await t.ask('Set a PIN now? [y] set it, [s] skip for now, [n] never ask again: ')).toLowerCase();
  if (answer === 'n' || answer === 'never') {
    await api.neverAsk();
    t.say('The inbox will not ask again. Set a PIN any time with: your-attention pin set');
    return 'never';
  }
  if (answer === 'y' || answer === 'yes') {
    const pin = await choosePin(t);
    if (pin) {
      await api.set(pin);
      t.say('PIN set. If you forget it, run: your-attention pin reset');
      return 'set';
    }
  }
  t.say('Skipped. The inbox asks again at the next start, and the page asks when it opens.');
  return 'skipped';
}

/** The PIN calls over HTTP, with a token kept on this machine. */
export function httpPinApi(url: string, token: string): PinApi & { raw(method: string, path: string, body?: unknown): Promise<Response> } {
  const raw = (method: string, path: string, body?: unknown): Promise<Response> => fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ok = async (res: Response): Promise<Response> => {
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the inbox answered ${res.status}`);
    return res;
  };
  return {
    raw,
    async status() { return (await (await ok(await raw('GET', '/v1/pin'))).json()) as { set: boolean; neverAsk: boolean; lockedUntil: number | null }; },
    async set(pin) { await ok(await raw('PUT', '/v1/pin', { pin })); },
    async clear() { await ok(await raw('DELETE', '/v1/pin', {})); },
    async neverAsk() { await ok(await raw('PUT', '/v1/pin/never-ask', { neverAsk: true })); },
  };
}
