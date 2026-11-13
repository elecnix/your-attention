// `your-attention install` is read by an agent, so its output is a contract: one exact command per detected harness,
// nothing that could be mistaken for a question, and the restart warning every harness needs.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { HARNESSES, candidates, detect, installHelp, installReport, shellWord, which, type InstallFacts } from '../../src/node/install.ts';

const facts = (over: Partial<InstallFacts> = {}): InstallFacts => ({
  found: { claude: '/usr/local/bin/claude', pi: '/usr/local/bin/pi', opencode: undefined, codex: undefined, cline: undefined },
  brew: true,
  self: '/usr/local/bin/your-attention',
  ...over,
});

describe('your-attention install', () => {
  it('prints the exact command for each harness it finds', () => {
    const out = installReport(facts()).join('\n');
    assert.ok(out.includes('  claude mcp add -s user your-attention -- your-attention claude-channel'), out);
    assert.ok(out.includes('  pi install git:github.com/elecnix/your-attention'), out);
    assert.match(out, /^claude: \/usr\/local\/bin\/claude$/m);
    assert.match(out, /^pi: \/usr\/local\/bin\/pi$/m);
  });

  it('prints only the name and the help path for a harness it cannot find', () => {
    const out = installReport(facts()).join('\n');
    assert.match(out, /^opencode: not found on this PATH$/m);
    assert.match(out, /^ {2}your-attention install --help opencode$/m);
    // No command line for a harness this shell cannot see.
    assert.ok(!out.includes('your-attention opencode-plugin --write'), out);
  });

  it('warns that every harness restarts, and spells the Claude Code channel option in full', () => {
    const out = installReport(facts()).join('\n');
    assert.match(out, /Restart every harness you configure/, out);
    assert.ok(out.includes('  --dangerously-load-development-channels=server:your-attention'), out);
  });

  it('asks nothing: no prompt, no question mark, no reading from the terminal', () => {
    const out = installReport(facts()).join('\n');
    assert.ok(!out.includes('?'), out);
    assert.ok(!/\[y\/n\]|\(y\/n\)|Press any key|Continue\?/i.test(out), out);
    assert.match(out, /asks no question/, out);
  });

  it('says when this shell cannot see the command, and how to install it', () => {
    const out = installReport(facts({ self: undefined })).join('\n');
    assert.match(out, /^command: not on this PATH$/m, out);
    assert.match(out, /not about the machine/, out);
    assert.ok(out.includes('  brew install elecnix/tap/your-attention'), out);
    assert.ok(out.includes('  your-attention install --from-source /path/to/your-attention'), out);
  });

  it('offers the source route when brew answers nowhere, and the brew route when it does', () => {
    const noBrew = installReport(facts({ brew: false })).join('\n');
    assert.ok(noBrew.includes('  your-attention install --from-source /path/to/your-attention'), noBrew);
    assert.ok(noBrew.includes('brew answers nowhere on this PATH'), noBrew);
    const brew = installReport(facts()).join('\n');
    assert.ok(brew.includes('brew install elecnix/tap/your-attention'), brew);
  });

  it('prints the whole recipe for one harness, installed or not', () => {
    const claude = (installHelp('claude', facts()) ?? []).join('\n');
    assert.ok(claude.includes('  claude mcp add -s user your-attention -- your-attention claude-channel'), claude);
    assert.ok(claude.includes('--dangerously-load-development-channels=server:your-attention'), claude);
    const absent = (installHelp('opencode', facts()) ?? []).join('\n');
    assert.match(absent, /On this PATH: nothing/, absent);
    assert.ok(absent.includes('  your-attention opencode-plugin --write'), absent);
    assert.equal(installHelp('nope', facts()), undefined);
  });

  it('names every harness the CLI knows, and the harnesses with no plugin say so', () => {
    const out = installReport(facts({ found: Object.fromEntries(HARNESSES.map((h) => [h.name, `/usr/bin/${h.binary}`])) })).join('\n');
    for (const h of HARNESSES) assert.match(out, new RegExp(`^${h.name}: `, 'm'), out);
    assert.match(out, /^ {2}no plugin: Codex reaches the inbox/m, out);
  });

  it('finds a Windows shim, and quotes a path a shell would otherwise split', () => {
    // An npm install on Windows writes your-attention.cmd beside the name, so the bare name finds nothing.
    assert.deepEqual(candidates('pi', 'win32'), ['pi', 'pi.cmd', 'pi.exe', 'pi.bat']);
    assert.deepEqual(candidates('pi', 'linux'), ['pi']);
    const dir = path.join(path.sep, 'tools');
    assert.equal(which('pi', dir, (f) => f === path.join(dir, 'pi.cmd'), 'win32'), path.join(dir, 'pi.cmd'));
    // A path with a space or a quote must survive a copy into a shell.
    assert.equal(shellWord('/a b/c'), "'/a b/c'");
    assert.equal(shellWord("/a'b"), "'/a'\\''b'");
    const out = installReport(facts({ fromSource: '/a b/your-attention' })).join('\n');
    assert.ok(out.includes("cd '/a b/your-attention' && npm ci && npm link"), out);
  });

  it('finds a binary without running anything, and reports the first directory that has it', () => {
    // The separator and the join come from the platform: a Windows PATH splits on ';' and joins with a backslash.
    const one = path.join(path.sep, 'one');
    const two = path.join(path.sep, 'two');
    const pathEnv = [one, two].join(path.delimiter);
    const piInTwo = path.join(two, 'pi');
    const seen: string[] = [];
    const found = which('pi', pathEnv, (f) => { seen.push(f); return f === piInTwo; });
    assert.equal(found, piInTwo);
    assert.deepEqual(seen, [path.join(one, 'pi'), piInTwo]);
    assert.equal(which('pi', one, () => false), undefined);
    const claudeInOne = path.join(one, 'claude');
    const harnesses = detect(pathEnv, (f) => f === claudeInOne);
    assert.equal(harnesses['claude'], claudeInOne);
    assert.equal(harnesses['pi'], undefined);
  });
});
