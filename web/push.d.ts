export function isIos(userAgent: string, touchPoints?: number): boolean;
export type PushSupport = { ok: true; mode: 'push' | 'page' } | { ok: false; reason: string };
export function pushSupport(env: { secure: boolean; ios: boolean; standalone: boolean; hasPush: boolean; hasNotification: boolean; permission: string }): PushSupport;
export function b64urlToBytes(text: string): Uint8Array;
type Api = (path: string, body?: unknown, method?: string) => Promise<Response>;
export function enablePush(opts: { base: string; collapsed: Iterable<string>; api: Api; notification?: typeof Notification; serviceWorker?: ServiceWorkerContainer }): Promise<PushSubscription>;
export function disablePush(opts: { base: string; api: Api; serviceWorker?: ServiceWorkerContainer }): Promise<void>;
export function hasPushSubscription(opts: { base: string; serviceWorker?: ServiceWorkerContainer }): Promise<boolean>;
