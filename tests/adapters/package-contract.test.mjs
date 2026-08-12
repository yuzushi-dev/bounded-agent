import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const agentPackage = path.join(root, 'adapters', 'agent-plugins');
const claudePackage = path.join(root, 'adapters', 'claude');
const ompPackage = path.join(root, 'adapters', 'omp-ohmy-pi');
const sharedSkill = path.join(root, 'plugins', 'bounded', 'skills', 'bounded-autonomy', 'SKILL.md');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('Agent Plugins adapter exposes the v1 portable package contract', () => {
  const manifest = readJson(path.join(agentPackage, 'plugin.json'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'bounded');
  assert.equal(manifest.version, '0.1.1');
  assert.ok(typeof manifest.description === 'string' && manifest.description.length > 0);
  assert.deepEqual(Object.keys(manifest).sort(), ['$schema', 'description', 'name', 'version']);

  const skill = path.join(agentPackage, 'skills', 'bounded-autonomy', 'SKILL.md');
  assert.equal(fs.readFileSync(skill, 'utf8'), fs.readFileSync(sharedSkill, 'utf8'));
  assert.equal(fs.existsSync(path.join(agentPackage, '.codex-plugin')), false);
  assert.equal(fs.existsSync(path.join(agentPackage, 'hooks')), false);
});

test('Claude adapter exposes native manifest, skill, and lifecycle hooks', () => {
  const manifest = readJson(path.join(claudePackage, '.claude-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'bounded');
  assert.equal(manifest.version, '0.1.1');
  assert.equal(manifest.skills, './skills/');
  assert.equal(fs.readFileSync(path.join(claudePackage, 'skills', 'bounded-autonomy', 'SKILL.md'), 'utf8'), fs.readFileSync(sharedSkill, 'utf8'));

  const hooks = readJson(path.join(claudePackage, 'hooks', 'hooks.json'));
  assert.ok(hooks.hooks.SessionStart?.length >= 1);
  assert.ok(hooks.hooks.PreToolUse?.length >= 1);
  assert.ok(hooks.hooks.PostToolUse?.length >= 1);
  assert.match(JSON.stringify(hooks), /CLAUDE_PLUGIN_ROOT/);
});

test('OMP/oh-my-pi adapter is a native default-export hook package', () => {
  const source = fs.readFileSync(path.join(ompPackage, 'bounded-hook.mjs'), 'utf8');
  assert.match(source, /export default/);
  assert.match(source, /tool_call/);
  assert.match(source, /tool_result/);
  assert.match(source, /bounded/);
  assert.doesNotMatch(source, /from ['"].*runtime|from ['"].*core/);
});
