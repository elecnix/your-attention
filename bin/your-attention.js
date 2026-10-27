#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Node runs the TypeScript sources directly, so there is no build step.
await import('../src/cli.ts');
