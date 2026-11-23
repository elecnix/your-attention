// The example triage agent: it dials in on the card.created hook, runs the checks in ./checks.ts on each new card, and
// passes the card or returns it to its agent with the reason. Run it with
//   node examples/triage-agent/triage-agent.ts [--config FILE] [--name NAME]
import { parseArgs } from 'node:util';
import { loadExtensionConfig } from '../../src/client.ts';
import { runCardHook } from '../../src/extensions/card-hook.ts';
import { checkCard, defaultConfigPath, hookTimeoutMs, loadConfig } from './checks.ts';
import { TriageState } from './state.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    name: { type: 'string', default: 'triage-example' },
    'screen-open': { type: 'boolean', default: false },
  },
});
const name = values.name;
const log = (...a: unknown[]): void => console.error(new Date().toISOString(), `[${name}]`, ...a);
const inbox = loadExtensionConfig();
if (!inbox) {
  log('No inbox found: start one with `your-attention serve`, or set YOUR_ATTENTION_URL and YOUR_ATTENTION_TOKEN to an extension token.');
  process.exit(1);
}
const configFile = values.config ?? defaultConfigPath();
const cfg = loadConfig(configFile, log);
// `--screen-open` takes the open cards that have no verdict yet on this connection. A restart without it goes back to
// screening new cards only.
const screen = values['screen-open'] ? 'open' : cfg.screen;
log(`config ${configFile}: vale ${JSON.stringify(cfg.vale)}, classifier ${JSON.stringify(cfg.classifier)}, PR verdict ${cfg.prVerdict ? JSON.stringify(cfg.prVerdict.command) : 'off'}, policy ${JSON.stringify(cfg.policy)}, at most ${cfg.maxReturns} returns, screening ${screen === 'open' ? 'the open cards too' : 'new cards only'}`);
const state = new TriageState(cfg.stateFile);
if (state.warning) log(state.warning);
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort());
await runCardHook({ ...inbox, name, timeoutMs: hookTimeoutMs(cfg), screen, log }, (ev, _call, signal) => checkCard(ev.card, cfg, (...a) => log(...a), { signal, state }), stop.signal);
