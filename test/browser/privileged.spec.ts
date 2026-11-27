// The privileged_action field on the real page: the person reads the command, types the fixture password and sends.
// The page seals the password to the broker's key, the inbox runs test/fixtures/pseudo-sudo.mjs with it, and the
// answer holds only what the command printed, with the password masked.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { PrivilegedRun, RunContext } from '../../src/core/privileged.ts';
import { localRunner } from '../../src/node/privileged.ts';
import { startInbox, type TestInbox } from './inbox.ts';

const PASSWORD = 'FIXTURE-PASSWORD-DO-NOT-USE';
const PSEUDO = path.resolve(import.meta.dirname, '..', 'fixtures', 'pseudo-sudo.mjs');

let inbox: TestInbox;
let work: string;
/** The runs of the approval machine: a stand-in for the ssh runner of a machine whose sudo needs no password. */
const approvals: { command: string; password: string; ctx: RunContext }[] = [];
test.beforeAll(async () => {
  inbox = await startInbox({ privileged: [localRunner('test-machine'), { machine: 'nas', sudo: 'approval', run: async (command, password, ctx) => { approvals.push({ command, password, ctx }); return { exitCode: 0, output: 'restarted\n' }; } }] });
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-privileged-page-'));
});
test.afterAll(async () => {
  await inbox.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test('the person types the password on the card, and the inbox runs the command it shows', async ({ page }) => {
  const marker = path.join(work, 'marker');
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(PSEUDO)} --expect-sha256 ${createHash('sha256').update(PASSWORD).digest('hex')} -- ${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}`;
  await inbox.agent.post({
    id: 'privileged', agent: 's-privileged', title: 'Create the marker file?', priority: 'now',
    body: `root = Card([run])\nrun = widget privileged_action ${JSON.stringify({ name: 'create_marker', command, machine: 'test-machine', changes: 'Creates a marker file in a temporary folder' })}`,
  });
  await inbox.open(page);
  const field = page.locator('fieldset.privileged');
  await expect(field.locator('legend')).toHaveText('Run on test-machine');
  await expect(field.locator('pre code')).toHaveText(command);
  await expect(field).toContainText('What it changes: Creates a marker file in a temporary folder');
  await field.getByLabel('Password to run create_marker on test-machine').fill(PASSWORD);
  await page.getByRole('button', { name: 'Send answer' }).click();

  await expect.poll(() => fs.existsSync(marker)).toBe(true);
  const { answer } = await inbox.detail('privileged');
  const run = answer?.values['create_marker'] as PrivilegedRun;
  expect(run.exitCode).toBe(0);
  expect(run.output).toContain('authenticated with [password]');
  expect(JSON.stringify(answer)).not.toContain(PASSWORD);
});

test('a machine that takes an approval shows a box instead of a password, and runs the command with none', async ({ page }) => {
  const command = '/usr/bin/systemctl restart smbd';
  await inbox.agent.post({
    id: 'privileged-nas', agent: 's-privileged', title: 'Restart smbd on nas?', priority: 'now',
    body: `root = Card([run])\nrun = widget privileged_action ${JSON.stringify({ name: 'restart_smbd', command, machine: 'nas', changes: 'Restarts the file server on nas' })}`,
  });
  await inbox.open(page);
  const field = page.locator('fieldset.privileged').filter({ hasText: 'Run on nas' });
  await expect(field.getByRole('checkbox', { name: 'Run this command on nas' })).toBeVisible();
  await expect(field.locator('input[type=password]')).toHaveCount(0);
  await field.getByRole('checkbox', { name: 'Run this command on nas' }).check();
  await page.getByRole('button', { name: 'Send answer' }).click();

  await expect.poll(() => approvals.length).toBe(1);
  expect(approvals[0]).toMatchObject({ command, password: '', ctx: { card: 'privileged-nas', field: 'restart_smbd' } });
  const { answer } = await inbox.detail('privileged-nas');
  expect((answer?.values['restart_smbd'] as PrivilegedRun).machine).toBe('nas');
});
