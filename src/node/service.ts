// Runs the inbox or an extension as a service that starts at login and
// restarts after a crash: a launchd agent on macOS, a systemd user unit on Linux.
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

// The files are for macOS and Linux, so their paths use slashes on every platform that writes them.
const path = nodePath.posix;

export interface ServiceFile {
  path: string;
  content: string;
  start: string;
  /** Stops the service until the next login. Exiting is not enough: the service manager would restart it. */
  stop: string;
  /** Exits 0 while the service manager has the service loaded and running. */
  running: string;
}

/** The node a unit names, and whether that path names one version of node, so the unit breaks when it changes. */
export interface UnitNode {
  path: string;
  versioned: boolean;
}

/** The node to name in a unit. Node reports its own path with every link resolved, so a Homebrew node reads as
 * `<prefix>/Cellar/<formula>/<version>/bin/node`, which `brew upgrade` deletes. Homebrew keeps `<prefix>/opt/<formula>`
 * pointing at the installed version, so the unit names that link when it exists. A version manager's node, such as
 * nvm's, has no such link, and the unit names its versioned path and says so. */
export function stableNode(execPath: string, exists: (p: string) => boolean = fs.existsSync): UnitNode {
  const brew = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (brew) {
    const opt = `${brew[1]}/opt/${brew[2]}/bin/node`;
    return exists(opt) ? { path: opt, versioned: false } : { path: execPath, versioned: true };
  }
  return { path: execPath, versioned: /\/(\.nvm|\.volta|\.fnm|\.asdf|\.local\/share\/mise)\//.test(execPath) || /\/v?\d+\.\d+\.\d+\//.test(execPath) };
}

/** One line for the unit that says why it names this node. */
function nodeNote(node: UnitNode, name: string): string {
  return node.versioned
    ? `This path names one node version: after you change node, run \`your-attention service ${name} --write\` again.`
    : 'This unit names node by a link that follows upgrades, such as Homebrew\'s opt link, because a brew upgrade deletes a versioned path.';
}

export function serviceFile(name: string, args: string[], platform: NodeJS.Platform = process.platform, bin = process.argv[1] ?? 'your-attention', node: UnitNode = stableNode(process.execPath)): ServiceFile {
  const label = `dev.your-attention.${name}`;
  const home = os.homedir();
  const log = path.join(home, '.your-attention', `${name}.log`);
  const exec = [node.path, '--disable-warning=ExperimentalWarning', bin, ...args];
  const note = nodeNote(node, name);
  if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return {
      path: file,
      start: `launchctl bootstrap gui/$(id -u) ${file}`,
      stop: `launchctl bootout gui/$(id -u)/${label}`,
      running: `launchctl print gui/$(id -u)/${label}`,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- ${esc(note).replace(/--/g, '- -')} -->
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${exec.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`,
    };
  }
  if (platform !== 'linux') throw new Error(`your-attention writes services for macOS (launchd) and Linux (systemd), not for ${platform}`);
  const file = path.join(home, '.config', 'systemd', 'user', `your-attention-${name}.service`);
  // systemd expands %-specifiers and $VARIABLES in ExecStart, even inside quotes, so both are doubled.
  const quote = (s: string) => {
    const lit = s.replace(/%/g, '%%').replace(/\$/g, '$$$$');
    return /[\s"\\]/.test(lit) ? `"${lit.replace(/(["\\])/g, '\\$1')}"` : lit;
  };
  return {
    path: file,
    start: `systemctl --user daemon-reload && systemctl --user enable --now your-attention-${name}`,
    stop: `systemctl --user stop your-attention-${name}`,
    running: `systemctl --user is-active --quiet your-attention-${name}`,
    content: `# ${note}
[Unit]
Description=your-attention ${name}

[Service]
ExecStart=${exec.map(quote).join(' ')}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`,
  };
}
