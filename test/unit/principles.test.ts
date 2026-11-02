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
