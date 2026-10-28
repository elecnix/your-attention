import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { herdrPlace } from '../../src/integrations/herdr/place.ts';

const fake = (calls: string[][]) => async (...args: string[]): Promise<string> => {
  calls.push(args);
  if (args[0] === 'pane') return JSON.stringify({ result: { pane: { pane_id: 'w3:p2', tab_id: 'w3:t5', workspace_id: 'w3' } } });
  if (args[0] === 'tab') return JSON.stringify({ result: { tab: { tab_id: 'w3:t5', label: 'login fix', number: 2 } } });
  return JSON.stringify({ result: { workspace: { workspace_id: 'w3', label: 'DevEx', number: 4 } } });
};

describe('the herdr workspace and tab of a pane', () => {
  it('names the workspace and the tab the pane sits in now', async () => {
    const calls: string[][] = [];
    assert.deepEqual(await herdrPlace('w3:p2', fake(calls)), { herdrWorkspace: 'DevEx', herdrTab: 'login fix' });
    assert.deepEqual(calls, [['pane', 'current', '--pane', 'w3:p2'], ['tab', 'get', 'w3:t5'], ['workspace', 'get', 'w3']]);
  });

  it('is empty outside herdr, for a malformed pane, or when herdr fails', async () => {
    assert.deepEqual(await herdrPlace(undefined, fake([])), {});
    assert.deepEqual(await herdrPlace('w3:p2; rm', fake([])), {});
    assert.deepEqual(await herdrPlace('w3:p2', async () => { throw new Error('no server'); }), {});
  });
});
