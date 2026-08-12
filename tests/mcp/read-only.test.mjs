import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const results = JSON.parse(fs.readFileSync(path.join(root, 'spikes/cross-runtime/fixtures/live-results.json'), 'utf8'));
const decision = fs.readFileSync(path.join(root, 'spikes/cross-runtime/README.md'), 'utf8');

test('NO-GO lanes create neither an unneeded MCP authority surface nor compatibility shells', () => {
  assert.equal(results.lanes['codex-to-claude'].clean.outcome, 'NO_GO');
  assert.equal(results.lanes['claude-to-codex'].clean.outcome, 'NO_GO');
  assert.equal(fs.existsSync(path.join(root, 'mcp/server.mjs')), false);
  assert.equal(fs.existsSync(path.join(root, 'integrations/codex')), false);
  assert.equal(fs.existsSync(path.join(root, 'integrations/claude')), false);
  assert.match(decision, /Task 9 has no real cross-runtime consumer/);
  assert.match(decision, /Task 10 requires a `GO` lane/);
});
