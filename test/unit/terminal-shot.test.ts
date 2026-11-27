// scripts/terminal-shot.sh once searched only PATH for a browser. On macOS, Chrome lives inside an application bundle
// and is not on PATH, so an agent that needed a screenshot built a google-chrome wrapper on a symlink to the real
// executable, and the redirect wrote through the link and replaced Chrome. These tests hold the supported ways to find
// a browser: the TERMINAL_SHOT_BROWSER variable, PATH, the macOS application paths and Playwright's Chromium.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../../scripts/terminal-shot.sh', import.meta.url));
const NO_BASH = process.platform === 'win32' ? 'the script is bash, and Windows runs no bash script' : false;

// The tools the script runs, linked into a directory that stands in for PATH, so no browser on the machine is found.
const TOOLS = ['bash', 'sh', 'python3', 'node', 'mktemp', 'seq', 'grep', 'sleep', 'rm', 'cat'];

let root = '';
let bin = '';

/** Writes an executable shell script. */
function script(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** A stand-in browser that records its arguments. */
function stub(file: string): string {
  return script(file, `printf '%s\\n' "$0" "$@" > "${root}/browser.log"`);
}

function shot(env: Record<string, string>): { status: number | null; out: string; browser: string | null; tmux: boolean } {
  const r = spawnSync('bash', [SCRIPT, '-o', path.join(root, 'shot.png'), '--', 'true'], {
    env: {
      PATH: bin,
      HOME: root,
      // Playwright looks for its browsers here, so an empty folder means it has none.
      PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'no-playwright'),
      TERMINAL_SHOT_APPLICATIONS: path.join(root, 'Applications'),
      ...env,
    },
    encoding: 'utf8',
  });
  const log = path.join(root, 'browser.log');
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    browser: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n')[0]! : null,
    tmux: fs.existsSync(path.join(root, 'tmux.log')),
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-shot-')));
  bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const tool of TOOLS) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(bin, tool));
  }
  // A tmux that draws a finished pane at once, so the test needs no tmux on the machine.
  script(path.join(bin, 'tmux'), `echo "$@" >> "${root}/tmux.log"
for a; do [ "$a" = capture-pane ] && { echo '[exited 0]'; exit 0; }; done
exit 0`);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('the browser terminal-shot.sh renders with', () => {
  it('is the one TERMINAL_SHOT_BROWSER names, when PATH holds no browser', { skip: NO_BASH }, () => {
    const browser = stub(path.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
    const r = shot({ TERMINAL_SHOT_BROWSER: browser });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.browser, browser);
  });

  it('is the macOS application when neither the variable nor PATH names one', { skip: NO_BASH }, () => {
    const browser = stub(path.join(root, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
    const r = shot({});
    assert.equal(r.status, 0, r.out);
    assert.equal(r.browser, browser);
  });

  it('is Chromium from its macOS application when Chrome is not installed', { skip: NO_BASH }, () => {
    const browser = stub(path.join(root, 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    const r = shot({});
    assert.equal(r.status, 0, r.out);
    assert.equal(r.browser, browser);
  });

  it('is the Chromium Playwright downloads when no other browser is found', { skip: NO_BASH }, () => {
    const folder = path.join(root, 'playwright');
    const repo = fileURLToPath(new URL('../..', import.meta.url));
    const where = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("playwright-core").chromium.executablePath())'], {
      cwd: repo,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: folder },
      encoding: 'utf8',
    }).stdout;
    assert.ok(where.startsWith(folder), where);
    const browser = stub(where);
    const r = shot({ PLAYWRIGHT_BROWSERS_PATH: folder });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.browser, browser);
  });

  it('is the one on PATH before a macOS application', { skip: NO_BASH }, () => {
    stub(path.join(root, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
    const browser = stub(path.join(bin, 'chromium'));
    const r = shot({});
    assert.equal(r.status, 0, r.out);
    assert.equal(r.browser, browser);
  });

  it('is the variable before PATH', { skip: NO_BASH }, () => {
    stub(path.join(bin, 'google-chrome'));
    const browser = stub(path.join(root, 'chosen', 'chrome'));
    const r = shot({ TERMINAL_SHOT_BROWSER: browser });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.browser, browser);
  });

  it('is refused by name when TERMINAL_SHOT_BROWSER is not executable, and nothing runs', { skip: NO_BASH }, () => {
    stub(path.join(bin, 'google-chrome'));
    const plain = path.join(root, 'not-a-browser');
    fs.writeFileSync(plain, 'text\n', { mode: 0o644 });
    for (const value of [plain, path.join(root, 'missing'), root]) {
      const r = shot({ TERMINAL_SHOT_BROWSER: value });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /TERMINAL_SHOT_BROWSER/);
      assert.ok(r.out.includes(value), r.out);
      assert.equal(r.browser, null, 'no browser runs');
      assert.equal(r.tmux, false, 'no terminal starts');
    }
  });

  it('is missing with an error that names TERMINAL_SHOT_BROWSER and forbids a shim', { skip: NO_BASH }, () => {
    const r = shot({});
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /TERMINAL_SHOT_BROWSER/);
    assert.match(r.out, /never wrap, link or replace/i);
    assert.equal(r.tmux, false, 'no terminal starts');
  });

  it('writes only its output file in the caller folder', { skip: NO_BASH }, () => {
    const browser = stub(path.join(root, 'chosen', 'chrome'));
    const before = fs.readdirSync(root).sort();
    shot({ TERMINAL_SHOT_BROWSER: browser });
    const added = fs.readdirSync(root).filter((name) => !before.includes(name)).sort();
    assert.deepEqual(added, ['browser.log', 'tmux.log'], 'only the stand-ins write here');
  });
});
