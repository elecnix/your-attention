// Runs the inbox or an extension as a service that starts at login and
// restarts after a crash: a launchd agent on macOS, a systemd user unit on Linux.
import os from 'node:os';
import nodePath from 'node:path';

// The files are for macOS and Linux, so their paths use slashes on every platform that writes them.
const path = nodePath.posix;

export interface ServiceFile {
  path: string;
  content: string;
  start: string;
}

export function serviceFile(name: string, args: string[], platform: NodeJS.Platform = process.platform, bin = process.argv[1] ?? 'your-attention'): ServiceFile {
  const label = `dev.your-attention.${name}`;
  const home = os.homedir();
  const log = path.join(home, '.your-attention', `${name}.log`);
  const exec = [process.execPath, '--disable-warning=ExperimentalWarning', bin, ...args];
  if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return {
      path: file,
      start: `launchctl bootstrap gui/$(id -u) ${file}`,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
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
    content: `[Unit]
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
