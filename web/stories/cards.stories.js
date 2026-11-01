import { Attachments, BroadcastForm, CardView, Changes, ClosedCard, HtmlCard, LinkedText, SecretForm } from '../components.js';
import { h } from '../env.js';
import { installPaste } from '../paste-images.js';
import { PNG, card, dataUrl, mount } from './render.js';
import { expandWidgets } from '../../src/core/widgets.ts';
import PULL_REQUEST from '../../examples/widgets/pull-request.openui?raw';

export default { title: 'Cards' };

const view = (c) => h(CardView, { draftKey: `story:${c.id}`, card: c, onAction: () => {} });

export const Choice = { render: () => mount(view(card({ options: [{ id: 'o1', label: 'SQLite', description: 'One file, FTS5 search' }, { id: 'o2', label: 'Postgres', description: 'A server to run' }] }))) };

export const MultipleChoice = { render: () => mount(view(card({ title: 'Which checks run on every push?', multiple: true, options: [{ id: 'a', label: 'Unit tests' }, { id: 'b', label: 'Integration tests' }, { id: 'c', label: 'Browser tests' }] }))) };

export const AskUserQuestion = {
  render: () => mount(view(card({ title: 'Which port?', questions: [{ question: 'Which port?', options: [{ label: '4815', description: 'The default' }, { label: '8080' }] }, { question: 'Advertise over mDNS?', options: [{ label: 'Yes' }, { label: 'No' }] }] }))),
};

export const BlockedAgentWithChoices = { render: () => mount(view(card({ kind: 'blocked', title: 'api-tests is waiting for you', text: 'Do you want to proceed?', options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No, and tell Claude what to do differently (esc)' }], screen: 'Bash command\n  npm run test:e2e\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)' }))) };
export const BlockedAgent = { render: () => mount(view(card({ kind: 'blocked', deliver: 'none', title: 'api-tests is waiting for you', screen: 'Bash command\n  npm run test:e2e\nDo you want to proceed?\n❯ 1. Yes\n  2. No' }))) };

export const WithLinks = {
  render: () => {
    const target = card({ id: 'c2', title: 'Pick the database', text: 'SQLite or Postgres.' });
    return mount(h(LinkedText, { text: 'This plan depends on [[c2]] and on [[missing]].', byId: { c2: target }, open: () => {} }));
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

export const Secret = { render: () => mount(h(SecretForm, { card: card({ kind: 'secret', title: 'Need the demo token', secret: { name: 'DEMO_TOKEN', publicKey: { kty: 'RSA' } } }), onSent: () => {}, onSkip: () => {} })) };

export const HtmlAllowed = { render: () => mount(h(HtmlCard, { card: card({ html: '<p style="font:16px sans-serif">Pick one:</p><button onclick="yourAttention.answer({colour:\'blue\'})">Blue</button>' }), allowed: true, onAnswer: () => {} })) };

export const HtmlBlocked = { render: () => mount(h(HtmlCard, { card: card({ html: '<p>hidden</p>' }), allowed: false, onAnswer: () => {} })) };

export const ClosedByAgent = {
  render: () => mount(h(ClosedCard, { closed: { kind: 'self-answered', outcome: 'Found it in the README.', at: Date.now() }, onNext: () => {}, animate: false }, view(card()))),
};

export const GuidanceBroadcast = {
  render: () => mount(h(BroadcastForm, { card: card({ kind: 'system', title: 'Send new card guidance to agents?', broadcast: { text: 'Attach a screenshot to every UI card.', agents: ['claude:3239ab8e', 'pi:01a17c01', 'herdr:w1:p2'] } }), onDone: () => {} })),
};

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
    const here = () => (root.querySelector('textarea') ? 'c1' : null);
    if (!pasteInstalled) { pasteInstalled = true; installPaste(here); }
    const bytes = Uint8Array.from(atob(PNG.split(',')[1]), (c) => c.charCodeAt(0));
    const paste = (name) => {
      const box = root.querySelector('textarea');
      if (!box) return setTimeout(() => paste(name), 50);
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: 'image/png' }));
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    };
    paste('layout-a.png');
    setTimeout(() => paste('layout-b.png'), 100);
    return root;
  },
};
