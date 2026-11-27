// Runs `node --test` with the given flags and patterns, after checking that each pattern selects at least one file.
// `node --test "nothing/**/*.test.ts"` reports 0 tests and exits 0, so a moved or misspelled folder would turn a test job
// green while it runs nothing. Node has no flag that makes an empty selection an error.
//
// Usage: node scripts/node-test.ts [node flags] -- PATTERN...
// The flags go before `--` and the patterns after it, so a flag whose value is a separate argument, such as
// `--test-reporter spec`, is never read as a pattern. Both go to `node --test` as written, so Node expands the patterns
// exactly as it did before.
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';

const args = process.argv.slice(2);
const split = args.indexOf('--');
const flags = split === -1 ? [] : args.slice(0, split);
const patterns = split === -1 ? [] : args.slice(split + 1);
if (patterns.length === 0) {
  console.error('node-test: give the test file patterns after --, as in: node scripts/node-test.ts [flags] -- PATTERN...');
  process.exit(2);
}

const empty = patterns.filter((pattern) => globSync(pattern).length === 0);
if (empty.length > 0) {
  for (const pattern of empty) console.error(`node-test: the pattern ${pattern} selects no test file, so this run would test nothing`);
  process.exit(1);
}

const run = spawnSync(process.execPath, ['--test', ...flags, ...patterns], { stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
