// A service unit names the node that runs it. Node reports its own path resolved through every link, so a Homebrew
// node reads as a Cellar path with its version in it, and a unit that names that path stops at the next brew upgrade.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serviceFile, stableNode } from '../../src/node/service.ts';

const CELLAR = '/home/linuxbrew/.linuxbrew/Cellar/node/26.13.1_4/bin/node';
const OPT = '/home/linuxbrew/.linuxbrew/opt/node/bin/node';

describe('the node a service unit names', () => {
  it('takes Homebrew\'s opt link, which follows upgrades, over the versioned Cellar path', () => {
    assert.deepEqual(stableNode(CELLAR, (p) => p === OPT), { path: OPT, versioned: false });
    assert.deepEqual(stableNode('/opt/homebrew/Cellar/node@22/22.11.0/bin/node', (p) => p === '/opt/homebrew/opt/node@22/bin/node'), { path: '/opt/homebrew/opt/node@22/bin/node', versioned: false });
  });

  it('keeps the Cellar path when the opt link is missing, and says that it names one version', () => {
    assert.deepEqual(stableNode(CELLAR, () => false), { path: CELLAR, versioned: true });
  });

  it('says a node from a version manager names one version, and leaves a system node alone', () => {
    assert.equal(stableNode('/home/x/.nvm/versions/node/v22.11.0/bin/node', () => true).versioned, true);
    assert.deepEqual(stableNode('/usr/bin/node', () => true), { path: '/usr/bin/node', versioned: false });
  });

  it('writes the stable path into the unit, with a comment that says why', () => {
    const linux = serviceFile('bellwether', ['bellwether'], 'linux', '/opt/ya/bin/your-attention.js', { path: OPT, versioned: false });
    assert.match(linux.content, new RegExp(`^ExecStart=${OPT} `, 'm'));
    assert.match(linux.content, /^# .*opt link.*brew upgrade/m);
    const pinned = serviceFile('bellwether', ['bellwether'], 'linux', '/opt/ya/bin/your-attention.js', { path: CELLAR, versioned: true });
    assert.match(pinned.content, /^# .*names one node version.*service bellwether --write/m);
    const mac = serviceFile('bellwether', ['bellwether'], 'darwin', '/opt/ya/bin/your-attention.js', { path: OPT, versioned: false });
    assert.match(mac.content, /<!-- .*opt link.* -->/);
    assert.match(mac.content, new RegExp(`<string>${OPT}</string>`));
  });
});
