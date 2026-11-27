// deploy-cloudflare.yml deploys the hosted service. A run that took the old default mode, single, made every hosted
// inbox answer 404 for four minutes. These tests keep the mode explicit, and keep its check in front of every upload.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// A Windows checkout may turn the line ends into CRLF.
const WORKFLOW = fs.readFileSync(new URL('../../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SCRIPT = fileURLToPath(new URL('../../scripts/check-deploy-mode.sh', import.meta.url));
// The check runs on the Ubuntu runner of the deploy, so its cases run where bash is the shell.
const NO_BASH = process.platform === 'win32' ? 'the deploy runs the check on Ubuntu, and Windows runs no bash script' : false;

function check(mode: string | undefined, signed: boolean): { ok: boolean; out: string } {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], INBOX_ID_SECRET_SET: String(signed) };
  if (mode !== undefined) env['MODE'] = mode;
  const r = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

/** Each job of the workflow, with the text of its block. */
function jobs(): Map<string, string> {
  const body = WORKFLOW.slice(WORKFLOW.indexOf('\njobs:\n') + 7);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/^ {2}([\w-]+):\n((?:(?: {4}.*)?\n)*)/gm)) out.set(m[1]!, m[2]!);
  return out;
}

describe('the mode of a deploy', () => {
  it('refuses a run that names no mode', { skip: NO_BASH }, () => {
    for (const mode of [undefined, '', 'choose', 'Hosted']) {
      const r = check(mode, true);
      assert.equal(r.ok, false, `mode ${mode}`);
      assert.match(r.out, /name the mode/);
    }
  });

  it('refuses single in an environment that signs hosted inbox addresses, and hosted without the key', { skip: NO_BASH }, () => {
    const single = check('single', true);
    assert.equal(single.ok, false);
    assert.match(single.out, /404 at every inbox address/);
    assert.equal(check('hosted', false).ok, false);
  });

  it('lets an explicit mode through when the environment agrees', { skip: NO_BASH }, () => {
    assert.equal(check('hosted', true).ok, true);
    assert.equal(check('single', false).ok, true);
  });

  it('has no deploy mode as the default of the input', () => {
    const input = WORKFLOW.slice(WORKFLOW.indexOf('      mode:'), WORKFLOW.indexOf('      code_update:'));
    assert.match(input, /default: choose\n/);
    assert.match(input, /options: \[choose, hosted, single\]/);
  });

  it('runs the check before any job that uploads', () => {
    const all = jobs();
    assert.ok(all.get('mode')?.includes('scripts/check-deploy-mode.sh'), 'the mode job runs the check');
    for (const [name, block] of all) {
      if (name === 'mode') continue;
      assert.match(block, /needs: (mode|\[mode\b[^\]]*\])/, `${name} needs the mode job`);
    }
    assert.ok(all.size >= 3, 'the workflow has the mode job and both deploy jobs');
  });
});
