// The agents panel: who the inbox knows, and the one form that sends a card to the agent picked in its drop-down.
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
      // A session that holds a connection and has posted no card: its presence row is the only place its name appears.
      'pi:9c1': { agent: 'pi:9c1', online: true, lastSeen: NOW, origin: { harness: 'pi', session: '9c1', name: 'Rename the retry flag', host: 'vandenberg' } },
    },
  };
}

// A story opens the panel, since nothing clicks in a story. Its drop-down lists the four agents, the first one
// picked, with what presence says about it under the field.
export const SendACardToAnAgent = { render: () => mount(h(AgentsPanel, { state: state(), startOpen: true })) };
