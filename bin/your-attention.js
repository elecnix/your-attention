#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Node runs the TypeScript sources directly, so a checkout has no build step. A package
// installed from npm is different: Node refuses to strip types under `node_modules`, so the
// published tarball carries `dist/`, written by `scripts/pack-sources.js` at pack time.
const compiled = new URL('../dist/src/cli.js', import.meta.url);
const hasCompiled = await import('node:fs').then((fs) => fs.existsSync(compiled));
await import(hasCompiled ? compiled.href : new URL('../src/cli.ts', import.meta.url).href);
