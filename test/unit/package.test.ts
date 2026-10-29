// pi loads this package as an extension and provides typebox itself. An extension that installs its own copy can
// bypass pi's extension loader and load a second runtime module, so pi wants the host's packages as peers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;

describe('package.json for the pi extension', () => {
  it('declares typebox, which pi provides, as a peer with any version, and installs it only for development', () => {
    assert.equal(pkg['peerDependencies']?.['typebox'], '*');
    assert.equal(pkg['dependencies']?.['typebox'], undefined);
    assert.match(pkg['devDependencies']?.['typebox'] ?? '', /^\d+\.\d+\.\d+$/);
  });
});
