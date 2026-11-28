// GET /v1/info names the build an inbox runs, so a person can tell from outside whether a deploy landed, whether a
// service came back on an old binary, and whether two machines agree. Each answer is checked against the package.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createHandler } from '../../src/core/http.ts';
import { Inbox } from '../../src/core/inbox.ts';
import { MemoryStorage } from '../../src/core/storage.ts';
import { PROTOCOL_VERSION } from '../../src/core/types.ts';
import { nodeBuild } from '../../src/node/build.ts';

const root = path.join(import.meta.dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

/** Run `body` in a new folder outside every checkout, then remove the folder. */
function inTempDir(body: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ya-build-'));
  try { body(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

type Info = { version?: unknown; commit?: unknown; protocol?: unknown };
async function info(build = nodeBuild(), prefix = '/v1'): Promise<{ status: number; body: Info }> {
  const res = await createHandler(new Inbox(new MemoryStorage(), Date.now, undefined, { build }))(new Request(`http://inbox.test${prefix}/info`));
  return { status: res.status, body: (await res.json()) as Info };
}

describe('the build an inbox reports', () => {
  it('names the version its package declares', async () => {
    const { body } = await info();
    assert.equal(body.version, pkg.version, `GET /v1/info answered version ${String(body.version)}, but package.json declares ${pkg.version}`);
  });

  it('names the commit of the checkout it runs from', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const { body } = await info();
    assert.equal(body.commit, head, `GET /v1/info answered commit ${String(body.commit)}, but the checkout is at ${head}`);
  });

  it('names the version and commit a packed install was stamped with', () => {
    inTempDir((dist) => {
      fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify({ version: '9.8.7', commit: 'c'.repeat(40) }));
      assert.deepEqual(nodeBuild(dist), { version: '9.8.7', commit: 'c'.repeat(40) });
    });
  });

  it('names the commit a release archive wrote, when it has no .git', () => {
    inTempDir((dir) => {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      execFileSync('git', ['archive', '--format=tar', '-o', path.join(dir, 'a.tar'), 'HEAD', 'COMMIT', 'package.json'], { cwd: root });
      execFileSync('tar', ['-xf', 'a.tar'], { cwd: dir });
      assert.deepEqual(nodeBuild(dir), { version: pkg.version, commit: head }, 'the archive names the commit it was made from');
    });
  });

  it('leaves the commit out when the platform knows none', async () => {
    assert.equal('commit' in (await info({ version: pkg.version })).body, false);
  });

  it('stamps a pack inside another project with no commit of that project', () => {
    inTempDir((outer) => {
      execFileSync('git', ['init', '-q'], { cwd: outer });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'outer'], { cwd: outer });
      const pkgDir = path.join(outer, 'vendor', 'your-attention');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
      fs.writeFileSync(path.join(pkgDir, 'COMMIT'), '$Format:%H$\n');
      assert.deepEqual(nodeBuild(pkgDir), { version: '1.2.3' }, 'the folder is not the top of the outer checkout, so its HEAD is not this build');
    });
  });

  it('names the protocol of the routes it serves, and serves them under that number', async () => {
    const { status, body } = await info(nodeBuild(), `/v${PROTOCOL_VERSION}`);
    assert.equal(status, 200);
    assert.equal(body.protocol, PROTOCOL_VERSION, `GET /v${PROTOCOL_VERSION}/info answered protocol ${String(body.protocol)}`);
  });
});
