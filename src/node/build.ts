// The build a Node process runs. A packed install reads the stamp that scripts/pack-sources.js wrote into dist/ when
// it was packed. A checkout reads its own package.json, and asks git for the commit it has checked out. A release
// archive has no .git, but git wrote the commit into its COMMIT file (export-subst in .gitattributes).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNKNOWN_BUILD, type Build } from '../core/version.ts';

/** Two folders up: the checkout from src/node/, and dist/ from dist/src/node/ in a package. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const readJson = (file: string): Record<string, unknown> | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return undefined; }
};

/** The commit HEAD names, when `root` is the top of a git checkout. A package installed inside another project's
 * checkout is not its top, so it never reports that project's commit. */
function checkoutCommit(root: string): string | undefined {
  try {
    const [top = '', head = ''] = execFileSync('git', ['rev-parse', '--show-toplevel', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim().split('\n');
    return fs.realpathSync(top) === fs.realpathSync(root) && /^[0-9a-f]{40,64}$/.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/** The commit a release archive wrote into COMMIT. In a checkout the file still holds its placeholder. */
export function archiveCommit(root: string): string | undefined {
  try {
    const text = fs.readFileSync(path.join(root, 'COMMIT'), 'utf8').trim();
    return /^[0-9a-f]{40,64}$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

let cached: Build | undefined;

/** The version and commit of the code this process runs, read once. */
export function nodeBuild(root = ROOT): Build {
  if (cached && root === ROOT) return cached;
  const stamp = readJson(path.join(root, 'build.json'));
  const pkg = stamp ?? readJson(path.join(root, 'package.json'));
  const version = typeof pkg?.['version'] === 'string' ? pkg['version'] : UNKNOWN_BUILD.version;
  const commit = stamp ? (typeof stamp['commit'] === 'string' ? stamp['commit'] : undefined) : (checkoutCommit(root) ?? archiveCommit(root));
  const build: Build = { version, ...(commit ? { commit } : {}) };
  if (root === ROOT) cached = build;
  return build;
}
