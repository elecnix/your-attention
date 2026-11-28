// The build a Worker runs. Wrangler bundles package.json with the code, so the version is the one the deployed package
// declares, and the deploy workflow sets the commit as the COMMIT variable.
import pkg from '../../package.json' with { type: 'json' };
import type { Build } from '../core/version.ts';

export function workerBuild(commit: string | undefined): Build {
  return { version: pkg.version, ...(commit ? { commit } : {}) };
}
