// The build a Node process runs. A packed install reads the stamp that scripts/pack-sources.js wrote into dist/ when
// it was packed. A checkout reads its own package.json, and the commit its HEAD names. A release
// archive has no .git, but git wrote the commit into its COMMIT file (export-subst in .gitattributes).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNKNOWN_BUILD, type Build } from '../core/version.ts';

/** Two folders up: the checkout from src/node/, and dist/ from dist/src/node/ in a package. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const readJson = (file: string): Record<string, unknown> | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return undefined; }
};

const COMMIT_ID = /^[0-9a-f]{40,64}$/;

const readText = (file: string): string | undefined => {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return undefined; }
};

/** The commit HEAD names, when `root` is the top of a git checkout. It reads the files git keeps, because spawning git
 * would slow every start of the inbox, most of all on Windows. A package inside another project's checkout has no
 * `.git` of its own, so it never reports that project's commit. */
export function checkoutCommit(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  let gitDir: string;
  try {
    // A worktree's .git is a file that names its folder inside the repository.
    gitDir = fs.statSync(dotGit).isDirectory() ? dotGit : path.resolve(root, /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1] ?? '');
  } catch {
    return undefined;
  }
  const head = readText(path.join(gitDir, 'HEAD'));
  if (!head) return undefined;
  if (COMMIT_ID.test(head)) return head;
  const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1];
  if (!ref) return undefined;
  // A worktree keeps its own HEAD, and shares the branches of the repository that commondir names.
  const common = path.resolve(gitDir, readText(path.join(gitDir, 'commondir')) ?? '.');
  for (const dir of [gitDir, common]) {
    const loose = readText(path.join(dir, ref));
    if (loose && COMMIT_ID.test(loose)) return loose;
  }
  // `git gc` moves branches into packed-refs, one "<commit> <ref>" a line.
  for (const line of (readText(path.join(common, 'packed-refs')) ?? '').split('\n')) {
    const [id, name] = line.split(' ');
    if (name === ref && id && COMMIT_ID.test(id)) return id;
  }
  return undefined;
}

/** The commit a release archive wrote into COMMIT. In a checkout the file still holds its placeholder. */
export function archiveCommit(root: string): string | undefined {
  try {
    const text = fs.readFileSync(path.join(root, 'COMMIT'), 'utf8').trim();
    return COMMIT_ID.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

let cached: Build | undefined;

/** The version and commit of the code this process runs, read once. */
export function nodeBuild(root = ROOT): Build {
  if (cached && root === ROOT) return cached;
  const stamp = readJson(path.join(root, 'build.json'));
  // Only this package's own package.json: a root resolved somewhere else, such as /, must not name another project.
  const own = readJson(path.join(root, 'package.json'));
  const pkg = stamp ?? (own?.['name'] === 'your-attention' ? own : undefined);
  if (!pkg) return UNKNOWN_BUILD;
  const version = typeof pkg?.['version'] === 'string' ? pkg['version'] : UNKNOWN_BUILD.version;
  const commit = stamp ? (typeof stamp['commit'] === 'string' ? stamp['commit'] : undefined) : (checkoutCommit(root) ?? archiveCommit(root));
  const build: Build = { version, ...(commit ? { commit } : {}) };
  if (root === ROOT) cached = build;
  return build;
}
