// The agents panel: who the inbox knows, and the card the person sends one of them.
import { AgentsPanel } from '../components.js';
import { h } from '../env.js';
import { card, mount } from './render.js';

export default { title: 'Agents' };

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** GET /v1/state, cut to what the panel reads: the card summaries, and presence. */
function state() {
  return {
    cards: [
      card({ id: 'a1', agent: 'claude:demo', title: 'Deploy the preview to staging?', origin: { harness: 'claude-code', name: 'storage', cwd: '/home/nicolas/Source/acme/api' }, createdAt: NOW - 2 * MINUTE }),
      card({ id: 'a2', agent: 'pi:5f2a', title: 'Which region goes first?', origin: { harness: 'pi', name: 'release', cwd: '/home/nicolas/Source/acme/release' }, createdAt: NOW - 3 * HOUR }),
      card({ id: 'a3', agent: 'cli:nightly', title: 'The nightly deploy finished.', origin: { harness: 'cli', name: 'nightly', cwd: '/srv/deploy' }, createdAt: NOW - 26 * HOUR }),
    ],
    presence: {
      'claude:demo': { agent: 'claude:demo', online: true, lastSeen: NOW },
      'pi:5f2a': { agent: 'pi:5f2a', online: false, lastSeen: NOW - 3 * HOUR },
    },
  };
}

// A story opens the panel, since nothing clicks in a story.
export const SendACardToAnAgent = { render: () => mount(h(AgentsPanel, { state: state(), startOpen: true })) };
