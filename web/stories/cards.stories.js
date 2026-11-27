import { Attachments, BroadcastForm, CardView, GrantRevoke, Changes, ClosedCard, HtmlCard, LinkedText, TriagePushback } from '../components.js';
import { h } from '../env.js';
import { installPaste } from '../paste-images.js';
import { PNG, card, dataUrl, mount } from './render.js';
import { DATABASE_URL, OPENAI_API_KEY, SEVERAL, accessCard } from './access.js';
import { BUILTIN_WIDGETS, expandWidgets } from '../../src/core/widgets.ts';
import PULL_REQUEST from '../../examples/widgets/pull-request.openui?raw';

export default { title: 'Cards' };

const { React } = window.__OpenUI;

const view = (c) => h(CardView, { draftKey: `story:${c.id}`, card: c, onAction: () => {} });

export const Choice = { render: () => mount(view(card({ options: [{ id: 'o1', label: 'SQLite', description: 'One file, FTS5 search' }, { id: 'o2', label: 'Postgres', description: 'A server to run' }] }))) };

export const MultipleChoice = { render: () => mount(view(card({ title: 'Which checks run on every push?', multiple: true, options: [{ id: 'a', label: 'Unit tests' }, { id: 'b', label: 'Integration tests' }, { id: 'c', label: 'Browser tests' }] }))) };

export const AskUserQuestion = {
  render: () => mount(view(card({ title: 'Which port?', questions: [{ question: 'Which port?', options: [{ label: '4815', description: 'The default' }, { label: '8080' }] }, { question: 'Advertise over mDNS?', options: [{ label: 'Yes' }, { label: 'No' }] }] }))),
};

// A card with three questions: each draws as its own section, with its text, its options and a comment field.
export const QuestionsWithText = {
  render: () => mount(view(card({ title: 'Three choices before the release', text: 'This agent prepares the 2.0 release and needs three decisions.', questions: [
    { question: 'Which database?', text: 'The service stores **one table** of jobs, about 10,000 rows.', options: [{ label: 'SQLite', description: 'One file next to the binary.', recommended: true }, { label: 'Postgres', description: 'A server to run and back up.' }] },
    { question: 'Which regions get the release first?', text: 'Each region adds a deploy step of about 4 minutes.', multiSelect: true, options: [{ label: 'us-east' }, { label: 'eu-west', recommended: true }, { label: 'ap-south' }] },
    { question: 'What must the release note say?', text: 'The note goes out with the tag.' },
  ] }))),
};
export const BlockedAgentWithChoices = { render: () => mount(view(card({ kind: 'blocked', title: 'api-tests is waiting for you', text: 'Do you want to proceed?', options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No, and tell Claude what to do differently (esc)' }], screen: 'Bash command\n  npm run test:e2e\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)' }))) };
export const BlockedAgent = { render: () => mount(view(card({ kind: 'blocked', deliver: 'none', title: 'api-tests is waiting for you', screen: 'Bash command\n  npm run test:e2e\nDo you want to proceed?\n❯ 1. Yes\n  2. No' }))) };

export const WithLinks = {
  render: () => {
    const at = Date.UTC(2026, 10, 2, 15, 0);
    const byId = Object.fromEntries(['c2', 'c3', 'c4'].map((id, i) => [id, card({ id, title: ['Pick the database', 'Rename the table', 'Bump the version'][i], text: 'SQLite or Postgres.' })]));
    const outcomes = { c2: { state: 'read', at }, c3: { state: 'closed', kind: 'self-answered', at }, c4: { state: 'open' } };
    const cleared = { old: { title: 'Rotate the key', preview: 'The key is 90 days old.', archivedAt: at, outcome: { state: 'closed', kind: 'retracted', at } } };
    return mount(h(LinkedText, { text: 'This plan follows [[c2]], [[c3]] and [[c4]], and [[old]] and [[missing]].', byId, open: () => {}, lookup: (id) => cleared[id] ?? null, outcomeOf: (id) => outcomes[id] }));
  },
};

export const Attached = {
  render: () => mount(h(Attachments, { files: [
    { url: PNG, name: 'a.png', type: 'image/png', alt: 'Layout A' },
    { url: PNG, name: 'b.png', type: 'image/png', alt: 'Layout B' },
    { url: dataUrl('text/markdown', '# Rollout plan\n\n1. Ship the **bridge**\n2. Then the relay\n\n| Step | Owner |\n|---|---|\n| bridge | agent |'), name: 'plan.md', type: 'text/markdown', size: 96 },
    { url: dataUrl('text/csv', 'name,score\nbridge,3\nrelay,5'), name: 'scores.csv', type: 'text/csv', size: 28 },
    { url: dataUrl('application/json', '{"ok":true,"cards":3}'), name: 'data.json', type: 'application/json', size: 21 },
    { url: 'https://example.com/logs.zip', name: 'logs.zip', type: 'application/zip', size: 524288 },
  ] })),
};

export const WhatChanged = {
  render: () => mount(h(Changes, { card: card({ text: 'Use SQLite with FTS5 for storage.', version: 2, history: [{ version: 1, title: 'Store sessions in SQLite or Postgres?', text: 'Use SQLite for storage.', at: Date.now() - 60000 }] }) })),
};

// Two returns by triage, and the agent's feedback on each. The section opens on a click.
export const TriagePushbackFeedback = {
  render: () => {
    const at = Date.now() - 120000;
    return mount(h(TriagePushback, { card: card({ version: 3, pushback: [
      { kind: 'returned', by: 'triage', reason: 'The card states no goal, and option B has no description.', version: 1, at,
        feedback: { verdict: 'partly', comment: 'The goal was in the title.', findings: [{ index: 1, verdict: 'disagree', comment: 'The title says it.' }, { index: 2, verdict: 'agree' }], agent: 'pi:release', at: at + 30000 } },
      { kind: 'returned', by: 'triage', reason: 'An earlier answer covers this card.', version: 2, at: at + 60000,
        feedback: { verdict: 'disagree', comment: 'The earlier answer was about another branch.', agent: 'pi:release', at: at + 90000 } },
    ] }) }));
  },
};

// The secret widget, placed beside a question, as the inbox expands it. The key is a stand-in: the story never seals.
const secretWidget = BUILTIN_WIDGETS.find((w) => w.name === 'secret').versions[0];
const secretBody = expandWidgets([
  'root = Card([intro, key, pick])',
  'intro = TextContent("This agent deploys the preview with the token.")',
  `key = widget secret ${JSON.stringify({ name: 'DEMO_TOKEN', publicKey: JSON.stringify({ kty: 'RSA', n: 'AQAB', e: 'AQAB' }) })}`,
  'pick = Form("pick", none, [where])',
  'none = Buttons([])',
  'where = FormControl("Where?", RadioGroup("where", [RadioItem("Staging", "", "staging"), RadioItem("Production", "", "prod")]))',
].join('\n'), () => ({ name: 'secret', ...secretWidget })).body;
export const Secret = { render: () => mount(view(card({ title: 'Need the demo token', body: secretBody, secrets: ['DEMO_TOKEN'] }))) };

// The privileged_action widget: the command exactly as the card gives it, the machine, what it changes, and the password.
const privilegedWidget = BUILTIN_WIDGETS.find((w) => w.name === 'privileged_action').versions[0];
const privilegedBody = expandWidgets([
  'root = Card([intro, restart])',
  'intro = TextContent("The new nginx configuration passed nginx -t. Restarting applies it.")',
  `restart = widget privileged_action ${JSON.stringify({ name: 'restart_nginx', command: "sudo -S -p '' systemctl restart nginx", machine: 'laptop', changes: 'Restarts nginx, which drops the open connections for about a second' })}`,
].join('\n'), () => ({ name: 'privileged_action', ...privilegedWidget })).body;
export const PrivilegedAction = { render: () => mount(view(card({ title: 'Restart nginx on laptop?', body: privilegedBody, privileged: ['restart_nginx'] }))) };

// The otp widget: the key, the purpose, the session that asks and the inbox that holds the key, and never a code.
const otpWidget = BUILTIN_WIDGETS.find((w) => w.name === 'otp').versions[0];
const otpBody = expandWidgets([
  'root = Card([intro, npm])',
  'intro = TextContent("The automated review of your-attention 1.4.0 passed. Approving gives this agent one code for the publish.")',
  `npm = widget otp ${JSON.stringify({ name: 'NPM_OTP', key: 'npm', purpose: 'npm stage approve your-attention@1.4.0', publicKey: JSON.stringify({ kty: 'RSA', n: 'AQAB', e: 'AQAB' }) })}`,
].join('\n'), () => ({ name: 'otp', ...otpWidget })).body;
export const OneTimeCode = { render: () => mount(view(card({ title: 'Approve the npm publish of your-attention 1.4.0?', body: otpBody, otp: ['NPM_OTP'], otpHolder: 'the laptop inbox on mbp, in ~/.your-attention/otp-keys.json, which only its user reads', origin: { harness: 'claude', name: 'release agent', host: 'mbp' } }))) };

export const HtmlAllowed = { render: () => mount(h(HtmlCard, { card: card({ html: '<p style="font:16px sans-serif">Pick one:</p><button onclick="yourAttention.answer({colour:\'blue\'})">Blue</button>' }), allowed: true, onAnswer: () => {} })) };

export const HtmlBlocked = { render: () => mount(h(HtmlCard, { card: card({ html: '<p>hidden</p>' }), allowed: false, onAnswer: () => {} })) };

export const ClosedByAgent = {
  render: () => mount(h(ClosedCard, { closed: { kind: 'self-answered', outcome: 'Found it in the README.', at: Date.now() }, onNext: () => {}, animate: false }, view(card()))),
};

// A card the person dismissed: the agent was not told, and only the person reads the draft they had on screen.
export const Dismissed = {
  render: () => {
    const c = card({ title: 'Store sessions in SQLite or Postgres?', options: [{ id: 'o1', label: 'SQLite' }, { id: 'o2', label: 'Postgres' }] });
    return mount(h(ClosedCard, { closed: { kind: 'dismissed', outcome: 'Nothing was sent to the agent.', at: Date.now(), draft: { values: { choice: 'o2' }, comment: 'Not this release, ask me again after the migration.', at: Date.now() } }, card: c, onNext: () => {}, animate: false }, view(c)));
  },
};

// A proposal that edits one word and adds one line: the unchanged lines collapse behind a control.
const GUIDANCE = 'Lead with the goal.\nGive two options, with the one you recommend first.\nEnd with a recommendation.';
// Live presence: two sessions online, with the names their connections reported, one of them in a herdr pane, and one
// that connected once and left.
const PRESENCE = {
  'claude:3239ab8e': { agent: 'claude:3239ab8e', online: true, lastSeen: 0, origin: { harness: 'claude-code', session: '3239ab8e', name: 'Rename the retry flag', herdrPane: 'w7:p2' } },
  'pi:01a17c01': { agent: 'pi:01a17c01', online: true, lastSeen: 0, origin: { harness: 'pi', session: '01a17c01', name: 'Queue layout' } },
  'herdr:w1:p2': { agent: 'herdr:w1:p2', online: false, lastSeen: 0, origin: { harness: 'herdr', name: 'Deploy watch', herdrPane: 'w1:p2' } },
};
const PROPOSAL = 'Lead with the goal.\nGive three options, with the one you recommend first.\nEnd with a recommendation.\nAttach a screenshot to every UI card.';
const guidanceStory = (guidance) => ({
  render: () => mount(h(BroadcastForm, {
    card: card({ kind: 'system', title: 'Send new card guidance to agents?', broadcast: { text: PROPOSAL, from: 'claude:3239ab8e', base: { version: 3, text: GUIDANCE } } }),
    presence: PRESENCE, guidance, onDone: () => {}, onSkip: () => {},
  })),
});
export const GuidanceBroadcast = guidanceStory({ text: GUIDANCE, version: 3, at: 0 });

// The guidance changed after the agent proposed its text: approving would remove the line added since.
export const GuidanceBroadcastAfterAChange = guidanceStory({ text: `${GUIDANCE}\nName the files the card is about.`, version: 4, at: 0 });

// A saved widget, placed twice in one card. The inbox expands the placing lines when the card is posted.
export const PullRequestWidgets = {
  render: () => {
    const body = expandWidgets([
      'root = Card([intro, first, second])',
      'intro = TextContent("Both pull requests pass CI. Merge them in this order?")',
      'first = widget pull-request {"title": "Add your-attention stop", "subtitle": "elecnix/your-attention · #12", "state": "CI green · 1 approval", "url": "https://github.com/elecnix/your-attention"}',
      'second = widget pull-request {"title": "Name agents by session", "subtitle": "elecnix/your-attention · #13", "state": "CI green · review requested", "url": "https://github.com/elecnix/your-attention"}',
    ].join('\n'), () => ({ name: 'pull-request', version: 1, source: PULL_REQUEST })).body;
    return mount(view(card({ title: 'Merge these two?', body, options: [{ id: 'yes', label: 'Merge both' }, { id: 'first', label: 'Only the first' }] })));
  },
};

// The comment box after the person pastes two images into it: a thumbnail for each, with a control to remove it.
let pasteInstalled = false;
export const WithPastedImages = {
  render: () => {
    const root = mount(view(card({ title: 'Which layout do you prefer?' })));
    // The listener outlives this story, so it names the card only while the story is on screen: a later story's paste
    // must not land on a card this one drew.
    // A detached node still answers `querySelector`, so ask the document: after Storybook swaps stories the div is
    // gone from the page, and a paste must then be left alone rather than filed under the card this one drew.
    const here = () => (root.isConnected && root.querySelector('textarea') ? 'c1' : null);
    if (!pasteInstalled) { pasteInstalled = true; installPaste(here); }
    const bytes = Uint8Array.from(atob(PNG.split(',')[1]), (c) => c.charCodeAt(0));
    // The story returns its root and Storybook puts it in the page afterwards, so wait for that: the listener names the
    // card only while the field is on screen, which is exactly what a real page gives it.
    let tries = 0;
    const paste = (name) => {
      const box = root.isConnected ? root.querySelector('textarea') : null;
      if (!box) {
        if (++tries < 100) setTimeout(() => paste(name), 20);
        return;
      }
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: 'image/png' }));
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    };
    paste('layout-a.png');
    setTimeout(() => paste('layout-b.png'), 100);
    return root;
  },
};

// The secret_access widget: one field per secret, each with the candidates the sources found.
export const SecretAccessOneCandidate = {
  render: () => mount(view(card({ id: 'access-one', title: 'Read the staging database', ...accessCard([{ name: 'DATABASE_URL', candidates: DATABASE_URL.slice(0, 1) }]) }))),
};
// Two age files of one name in two folders, told apart by their store.
export const SecretAccessSameNameTwoFolders = {
  render: () => mount(view(card({ id: 'access-folders', title: 'Read the staging database', ...accessCard([{ name: 'DATABASE_URL', candidates: DATABASE_URL }]) }))),
};
// One secret offered on two instances, and by a source that is off, which the person cannot pick.
export const SecretAccessTwoInstances = {
  render: () => mount(view(card({ id: 'access-two', title: 'Call the OpenAI API', ...accessCard([{ name: 'OPENAI_API_KEY', candidates: OPENAI_API_KEY }]) }))),
};
// Two secrets on one card: the person answers each field on its own.
export const SecretAccessSeveral = {
  render: () => mount(view(card({ id: 'access-several', title: 'Two secrets for the deploy', ...accessCard(SEVERAL) }))),
};
// No source holds the secret, so the person types its value, or declines.
export const SecretAccessTyped = {
  render: () => mount(view(card({ id: 'access-typed', title: 'Need the deploy token', ...accessCard([{ name: 'DEPLOY_TOKEN', candidates: [] }]) }))),
};
// A granted field on an answered card, with its Revoke button. A stand-in takes the revocation while the story is on
// screen, and every other request goes to the fetch the story found.
function RevokeStandIn({ children }) {
  React.useLayoutEffect(() => {
    const real = window.fetch;
    window.fetch = (url, init) => (/\/revoke$/.test(String(url)) ? Promise.resolve(Response.json({ ok: true })) : real(url, init));
    return () => { window.fetch = real; };
  }, []);
  return children;
}
export const SecretAccessGranted = {
  render: () => {
    const savedAt = Date.now() - 60000;
    const sealed = { alg: 'RSA-OAEP-256+A256GCM', key: 'AAAA', iv: 'AAAA', data: 'AAAA' };
    const answer = { values: { DATABASE_URL: { grant: '/home/me/work/.secrets/db-staging.age', source: 'age', instance: 'laptop', until: savedAt + 3600000, case: 'K7Q2', sealed } }, comment: '', savedAt };
    return mount(h(RevokeStandIn, null, h(GrantRevoke, { card: card({ id: 'access-granted' }), answer })));
  },
};

// A revision marks the picked candidate's source off: the pick loses its ceiling, and Send answer would send nothing.
export const SecretAccessRevised = {
  render: () => {
    function Revised() {
      const [off, setOff] = React.useState(false);
      const candidates = DATABASE_URL.map((c) => (off ? { ...c, status: 'off', reason: 'the identity file is gone' } : c));
      return h('div', null,
        h('button', { type: 'button', className: 'btn', onClick: () => setOff(true) }, 'Mark the source off'),
        view(card({ id: 'access-revised', version: off ? 2 : 1, title: 'Read the staging database', ...accessCard([{ name: 'DATABASE_URL', candidates }]) })));
    }
    return mount(h(Revised));
  },
};
