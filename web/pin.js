// The PIN of the inbox, on the page: the screen that unlocks a new tab, the
// prompt that offers to set a PIN, and the controls to change it or lock the tab.
import { BASE, J, h, unlockToken } from './env.js';
import { newPinKey, pinKey } from './pin-key.js';

const { React } = window.__OpenUI;

const send = (method, path, body) => fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-your-attention': '1' }, body: J(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
// The PIN never leaves the page. It derives a key with the salt and iterations of GET /v1/pin, and sends the key.
const pinState = () => fetch(`${BASE}v1/pin`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the inbox answered ${r.status}`))));
const currentKey = async (pin) => { const s = await pinState(); return pinKey(pin, s.salt, s.iterations); };

// A loopback, private network or .local address means a computer runs the inbox, and its CLI resets the PIN.
const LAPTOP = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|\[f[cd][0-9a-f:]*\]|\[fe80:[0-9a-f:]*\]|[\w-]+\.local)$/i;

const wait = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  if (s < 5400) return `${Math.ceil(s / 60)} minutes`;
  return `${Math.ceil(s / 3600)} hours`;
};

const pinInput = (props) => h('input', { type: 'password', inputMode: 'numeric', pattern: '[0-9]{4}', maxLength: 4, size: 6, className: 'pin-input', ...props,
  onChange: (e) => props.onChange(e.target.value.replace(/\D/g, '').slice(0, 4)) });

/** The screen of a locked tab. The PIN goes to POST /v1/unlock, and the unlock token stays in this tab's session storage. */
export function PinUnlock({ onUnlocked }) {
  const [pin, setPin] = React.useState('');
  const [error, setError] = React.useState(null);
  const [until, setUntil] = React.useState(null);
  const [now, setNow] = React.useState(Date.now());
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    fetch(`${BASE}v1/pin`).then((r) => (r.ok ? r.json() : null)).then((s) => { if (s && s.lockedUntil) setUntil(s.lockedUntil); }, () => {});
  }, []);
  React.useEffect(() => {
    if (!until) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  const locked = until && until > now;
  const submit = async (e) => {
    e.preventDefault();
    if (pin.length !== 4 || locked || busy) return;
    setBusy(true);
    const r = await currentKey(pin).then((key) => send('POST', 'v1/unlock', { key })).catch(() => ({ status: 0, body: { error: 'The inbox did not answer.' } }));
    setBusy(false);
    setPin('');
    if (r.status === 200 && r.body.unlock) { unlockToken.set(r.body.unlock); onUnlocked(); return; }
    if (r.status === 429 && r.body.lockedUntil) { setUntil(r.body.lockedUntil); setNow(Date.now()); setError(null); return; }
    setError(r.status === 401 ? `Wrong PIN. ${r.body.triesLeft} ${r.body.triesLeft === 1 ? 'try' : 'tries'} left before a wait.` : r.body.error || 'The inbox refused the PIN.');
  };
  return h('form', { className: 'signin pin-unlock', onSubmit: submit },
    h('h2', null, 'Unlock your inbox'),
    h('p', null, 'Type the PIN of this inbox. Each new tab asks for it, and closing the tab locks it again.'),
    h('div', { className: 'pin-row' },
      pinInput({ value: pin, onChange: setPin, autoFocus: true, autoComplete: 'current-password', 'aria-label': 'PIN', disabled: !!locked }),
      h('button', { type: 'submit', className: 'btn primary', disabled: pin.length !== 4 || !!locked || busy }, busy ? 'Checking…' : 'Unlock')),
    locked && h('p', { className: 'pin-error', role: 'status' }, `Too many wrong PINs. Try again in ${wait(until - now)}.`),
    !locked && error && h('p', { className: 'pin-error', role: 'alert' }, error),
    h('p', { className: 'pin-help' }, 'Forgot it? ', LAPTOP.test(location.hostname)
      ? h(React.Fragment, null, 'On the computer that runs the inbox, run ', h('code', null, 'your-attention pin reset'), '.')
      : h(React.Fragment, null, 'On a computer paired with this inbox as owner, run ', h('code', null, 'your-attention pin reset'), '.')));
}

/** Set a PIN, or change it with the current one. `offer` adds Skip and Never ask again, for an inbox that has none. */
export function PinForm({ set, offer, onDone, onSkip, onNever, onBusy = () => {} }) {
  const [current, setCurrent] = React.useState('');
  const [pin, setPin] = React.useState('');
  const [again, setAgain] = React.useState('');
  const [error, setError] = React.useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (pin.length !== 4) return setError('A PIN is 4 digits.');
    if (pin !== again) return setError('The two PINs differ.');
    onBusy(true);
    const r = await pinState()
      .then(async (s) => ({ ...(await newPinKey(pin, s.newIterations)), ...(set ? { current: await pinKey(current, s.salt, s.iterations) } : {}) }))
      .then((body) => send('PUT', 'v1/pin', body))
      .catch(() => ({ status: 0, body: { error: 'The inbox did not answer.' } }));
    if (r.status !== 200) { onBusy(false); return setError(r.body.error || 'The inbox refused the PIN.'); }
    if (r.body.unlock) unlockToken.set(r.body.unlock);
    onDone();
  };
  return h('form', { className: 'usage-notice pin-form', 'aria-label': set ? 'Change the PIN' : 'Set a PIN', onSubmit: submit },
    h('p', null, set
      ? 'Change the PIN of this inbox. Every other tab types the new PIN.'
      : 'Protect this inbox with a PIN. Anyone who gets its address or a sign-in link can answer your agents\' cards. With a PIN, each new tab asks for it first.'),
    h('div', { className: 'pin-row' },
      set && h('label', null, 'Current PIN ', pinInput({ value: current, onChange: setCurrent, autoComplete: 'current-password' })),
      h('label', null, 'New PIN ', pinInput({ value: pin, onChange: setPin, autoComplete: 'new-password', autoFocus: !set })),
      h('label', null, 'Again ', pinInput({ value: again, onChange: setAgain, autoComplete: 'new-password' }))),
    error && h('p', { className: 'pin-error', role: 'alert' }, error),
    h('div', { className: 'usage-actions' },
      h('button', { type: 'submit', className: 'btn primary' }, set ? 'Change PIN' : 'Set PIN'),
      offer && h('button', { type: 'button', className: 'btn', onClick: onSkip }, 'Skip'),
      offer && h('button', { type: 'button', className: 'btn', onClick: onNever }, 'Never ask again'),
      !offer && h('button', { type: 'button', className: 'btn', onClick: onSkip }, 'Cancel')));
}

/** At the foot of the queue: set or change the PIN, and lock this tab. */
export function PinControls({ pin, onEdit, onLock }) {
  if (!pin) return null;
  return h('div', { className: 'pin-controls' },
    h('button', { type: 'button', className: 'btn', onClick: onEdit }, pin.set ? 'Change PIN' : 'Set a PIN'),
    pin.set && h('button', { type: 'button', className: 'btn', onClick: onLock }, 'Lock this tab'));
}

/** End this tab's unlock token on the inbox, then forget it. */
export const lockTab = () => send('POST', 'v1/lock', {}).catch(() => null).then(() => unlockToken.del());

/** Tell the inbox "never ask again". */
export const neverAsk = () => send('PUT', 'v1/pin/never-ask', { neverAsk: true });
