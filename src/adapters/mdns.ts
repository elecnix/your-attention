// Discovery on a LAN with DNS-SD over mDNS, the protocol Bonjour and Avahi use.
// The announcement says only that an inbox exists. A client still has to pair.
import { Bonjour } from 'bonjour-service';
import os from 'node:os';

export const SERVICE_TYPE = 'cardinbox';

export interface Advertisement {
  stop(): Promise<void>;
}

export interface FoundInbox {
  name: string;
  host: string;
  addresses: string[];
  port: number;
  txt: Record<string, string>;
}

export function advertise(opts: { port: number; inboxId: string; name?: string }): Advertisement {
  const bonjour = new Bonjour({}, (err: Error) => console.error('[mdns]', err.message));
  bonjour.publish({
    name: opts.name ?? `your-attention on ${os.hostname().replace(/\.local$/, '')}`,
    type: SERVICE_TYPE,
    port: opts.port,
    txt: { v: '1', id: opts.inboxId, pair: '/v1/pair' },
  });
  return {
    stop: () => new Promise((resolve) => bonjour.unpublishAll(() => { bonjour.destroy(); resolve(); })),
  };
}

/** Listen for inboxes for `ms` milliseconds. */
export function discover(ms: number): Promise<FoundInbox[]> {
  const bonjour = new Bonjour({}, (err: Error) => console.error('[mdns]', err.message));
  const found = new Map<string, FoundInbox>();
  const browser = bonjour.find({ type: SERVICE_TYPE }, (s) => {
    found.set(s.name, {
      name: s.name,
      host: s.host,
      addresses: s.addresses ?? [],
      port: s.port,
      txt: Object.fromEntries(Object.entries((s.txt ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)])),
    });
  });
  return new Promise((resolve) => {
    setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      resolve([...found.values()]);
    }, ms);
  });
}
