// The unit a service manager loads: a launchd agent on macOS, a systemd user unit on Linux.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serviceFile } from '../../src/node/service.ts';
import type { UnitNode } from '../../src/node/service.ts';

const node: UnitNode = { path: '/opt/ya/bin/node', versioned: false };

describe('services', () => {
  it('writes a launchd agent on macOS and a systemd unit on Linux, both restarting on failure', () => {
    const mac = serviceFile('triage', ['triage', '--judge-cmd', 'claude -p'], 'darwin', '/opt/ya/bin/your-attention.js');
    assert.match(mac.path, /LaunchAgents\/dev\.your-attention\.triage\.plist$/);
    assert.match(mac.content, /<key>KeepAlive<\/key><true\/>/);
    assert.match(mac.content, /<string>claude -p<\/string>/);
    const linux = serviceFile('serve', ['serve'], 'linux', '/opt/ya/bin/your-attention.js');
    assert.match(linux.path, /systemd\/user\/your-attention-serve\.service$/);
    assert.match(linux.content, /Restart=always/);
    assert.match(linux.content, /ExecStart=.* \/opt\/ya\/bin\/your-attention\.js serve/);
  });

  it('passes on the PATH, the home and the herdr path of the shell that writes the unit', () => {
    const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', YOUR_ATTENTION_HOME: '/Users/me/100% inbox', HERDR_BIN_PATH: '/opt/homebrew/bin/herdr' };
    const mac = serviceFile('serve', ['serve'], 'darwin', '/opt/ya.js', node, env);
    assert.match(mac.content, /<key>EnvironmentVariables<\/key>/);
    assert.match(mac.content, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
    assert.match(mac.content, /<key>YOUR_ATTENTION_HOME<\/key><string>\/Users\/me\/100% inbox<\/string>/);
    assert.match(mac.content, /<key>HERDR_BIN_PATH<\/key><string>\/opt\/homebrew\/bin\/herdr<\/string>/);
    // systemd expands %-specifiers in Environment=, so a % is doubled there, and it is not in the plist.
    const linux = serviceFile('serve', ['serve'], 'linux', '/opt/ya.js', node, env);
    assert.match(linux.content, /Environment="PATH=\/opt\/homebrew\/bin:\/usr\/bin:\/bin"/);
    assert.match(linux.content, /Environment="YOUR_ATTENTION_HOME=\/Users\/me\/100%% inbox"/);
    assert.match(linux.content, /Environment="HERDR_BIN_PATH=\/opt\/homebrew\/bin\/herdr"/);
  });

  it('writes no environment when the shell that writes the unit has none of those', () => {
    assert.doesNotMatch(serviceFile('serve', [], 'darwin', '/opt/ya.js', node, {}).content, /EnvironmentVariables/);
    assert.doesNotMatch(serviceFile('serve', [], 'linux', '/opt/ya.js', node, {}).content, /Environment=/);
  });

  it('doubles % and $ for systemd, and refuses a platform it cannot serve', () => {
    const unit = serviceFile('triage', ['triage', '--judge-cmd', 'echo %h $HOME'], 'linux', '/opt/ya.js');
    assert.match(unit.content, /"echo %%h \$\$HOME"/);
    assert.throws(() => serviceFile('serve', ['serve'], 'win32'), /not for win32/);
  });

  it('stops each service through its service manager, which would restart a process that exits', () => {
    assert.equal(serviceFile('serve', [], 'darwin').stop, 'launchctl bootout gui/$(id -u)/dev.your-attention.serve');
    assert.equal(serviceFile('serve', [], 'linux').stop, 'systemctl --user stop your-attention-serve');
    assert.equal(serviceFile('serve', [], 'darwin').running, 'launchctl print gui/$(id -u)/dev.your-attention.serve');
    assert.equal(serviceFile('serve', [], 'linux').running, 'systemctl --user is-active --quiet your-attention-serve');
  });
});
