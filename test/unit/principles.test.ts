// Checks the principles that a test can read off the source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { check, principleHeadings } from '../../scripts/check-principle-links.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const core = fs.readdirSync(path.join(ROOT, 'src/core')).filter((f) => f.endsWith('.ts'));
const read = (f: string): string => fs.readFileSync(path.join(ROOT, 'src/core', f), 'utf8');

describe('principles', () => {
  it('the core uses web standards only', () => {
    for (const f of core) {
      const imports = [...read(f).matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
      for (const i of imports) assert.ok(i.startsWith('./'), `${f} imports ${i}: the core may import only other core files`);
      assert.doesNotMatch(read(f), /\b(process|Buffer|require)\b[.(]/, `${f} uses a Node global`);
    }
  });

  it('the inbox keeps no timers: timeouts come from the platform alarm', () => {
    assert.doesNotMatch(read('inbox.ts'), /set(Timeout|Interval)\(/);
  });

  it('the page shows an agent as connected only from presence, and keeps no list of its own', () => {
    // DP18 and DP34: presence comes from the connections an inbox holds right now. A list the page remembered would
    // show a session that has ended as connected, and the person would send a card that goes nowhere.
    const panel = fs.readFileSync(path.join(ROOT, 'web/agents.js'), 'utf8');
    assert.doesNotMatch(panel, /\b(localStorage|sessionStorage|store)\b/, 'the agent list lives in GET /v1/state only');
    assert.doesNotMatch(panel, /online:\s*true/, 'only a presence row makes an agent online');
  });

  it('a card that waited for an offline agent goes out when that agent connects', () => {
    // DP19: the inbox keeps what it cannot deliver yet, and hands it over when the session comes back.
    const connect = /connect\(caller: Caller[\s\S]*?\n  \}/.exec(read('inbox.ts'))?.[0] ?? '';
    assert.match(connect, /this\.deliverSent\(agent\);/, 'a connection takes the cards that waited for its agent');
  });

  it('the form that sends a card shows what presence says about the agent its drop-down picks', () => {
    // DP18: the person sees whether that agent is listening or offline before starting to write, and the form reads
    // it from the agent list that presence fills, not from a state of its own. A pick that left the list reads as
    // the first agent, so a card never goes to a name that presence dropped while the panel was open.
    const panel = fs.readFileSync(path.join(ROOT, 'web/components.js'), 'utf8');
    const form = /function SendForm[\s\S]*?\n}\n/.exec(panel)?.[0] ?? '';
    assert.match(form, /h\('select'/, 'one drop-down picks the agent a card goes to');
    assert.match(form, /\$\{agent\.status\}/, 'the state line is the picked agent\'s, from the presence list');
    assert.match(form, /pickedAgent\(agents, picked\)/, 'a pick that left the list reads as the first agent');
  });

  it('the guidance card labels each row from presence, and opens the pane a connection reported', () => {
    // DP14 and DP43: the person picks the agents that get the guidance by the name each session reports, not by an id
    // they cannot place, and a session in a herdr pane is one click away even when it posted no card.
    const panel = fs.readFileSync(path.join(ROOT, 'web/components.js'), 'utf8');
    const form = /export function BroadcastForm[\s\S]*?\n}\n/.exec(panel)?.[0] ?? '';
    assert.match(form, /agentName\(a, cards, presence\)/, 'a row reads its name from presence, then from the cards, then the id');
    assert.match(form, /https:\/\/herdr\.invalid\/v1\/pane\/\$\{pane\}/, 'a row of a session in a pane opens that pane');
  });

  it('a connection carries its origin onto the presence row', () => {
    // DP34: presence comes from the connections an inbox holds, so the name and the pane a session reports arrive with
    // the connection, and a session with no card in the inbox still has a name.
    const source = read('inbox.ts');
    assert.match(source, /this\.setPresence\(agent, true, opts\.channelOff, opts\.origin\);/, 'connect passes the origin it was given to the presence');
    assert.match(source, /connectionOrigin\(reported\) \?\? before\?\.origin/, 'a connection that reports none keeps the origin the row had');
  });

  it('a guidance proposal diffs only the editable text, so the catalog never reads as removed', () => {
    // DP14: the widget catalog and the tag values reach an agent beside the guidance text, so an approval card that
    // compared anything more would show them as lines the person deletes by approving.
    const guidance = / {2}guidance\(\): Guidance \{[\s\S]*?\n {2}\}/.exec(read('inbox.ts'))?.[0] ?? '';
    assert.match(guidance, /guidanceTextOnly\(stored\.text/, 'the stored text reads back as the guidance alone');
    assert.match(guidance, /this\.store\.put\('meta', 'guidance', repaired\)/, 'the repair is stored, so every read gives the same text');
    for (const f of ['web/components.js', 'src/tui/cardview.ts']) {
      const diff = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.match(diff, /guidanceDiff\(current\.text, b\.text/, `${f} diffs the two guidance texts, and nothing beside them`);
    }
  });

  it('every principle in PRINCIPLES.md has a statement and a reason', () => {
    const text = fs.readFileSync(path.join(ROOT, 'PRINCIPLES.md'), 'utf8').replace(/\r\n/g, '\n');
    const sections = text.split('\n### ').slice(1);
    assert.ok(sections.length >= 40, `found ${sections.length} principles`);
    for (const s of sections) {
      const paragraphs = s.split('\n## ')[0]!.split('\n\n').slice(1).filter((p) => p.trim());
      assert.ok(paragraphs.length >= 2, `principle "${s.split('\n')[0]}" needs a statement and a reason`);
    }
  });

  it('every principle is numbered, in document order', () => {
    const headings = principleHeadings(ROOT);
    assert.deepEqual(
      headings.map((h) => h.title.match(/^DP(\d+): /)?.[1]),
      headings.map((_, i) => String(i + 1)),
      'each heading reads DP1, DP2, … in document order',
    );
  });

  it('every link to a principle reaches a heading', () => {
    const { headings, links, broken, mismatched } = check(ROOT);
    assert.ok(links.length >= 3, `found ${links.length} links to a principle`);
    assert.deepEqual(
      broken.map((l) => `${l.file}:${l.line}: ${l.text}`),
      [],
      'each link names an anchor of a heading in PRINCIPLES.md',
    );
    assert.deepEqual(
      mismatched.map((l) => `${l.file}:${l.line}: ${l.text}`),
      [],
      'each link that shows a number shows the number of the heading it reaches',
    );
    assert.equal(new Set(headings.map((h) => h.anchor)).size, headings.length, 'every heading has its own anchor');
  });
});
