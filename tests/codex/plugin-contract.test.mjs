import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const packageRoot = path.resolve(new URL('../../plugins/bounded/', import.meta.url).pathname);

test('bounded plugin exposes an independent public manifest', () => {
  const manifestPath = path.join(packageRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.name, 'bounded');
  assert.equal(manifest.version, '0.1.1');
  assert.equal(manifest.skills, './skills/');
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);
  assert.equal(Object.hasOwn(manifest, 'apps'), false);
  const publicText = JSON.stringify(manifest).toLowerCase();
  assert.equal(publicText.includes('omp-bounded'), false);
  assert.equal(publicText.includes('oh-my-pi'), false);
  assert.ok(fs.existsSync(path.join(packageRoot, 'skills', 'bounded-autonomy', 'SKILL.md')));

  const hooks = JSON.parse(fs.readFileSync(path.join(packageRoot, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(hooks.hooks.SessionStart?.length >= 1);
  assert.ok(hooks.hooks.PreToolUse?.length >= 1);
  assert.ok(hooks.hooks.PostToolUse?.length >= 1);
  assert.match(JSON.stringify(hooks), /bounded-hook\.mjs/);
});

test('bounded runtime imports stay inside the plugin or use Node built-ins', () => {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (target.endsWith('.mjs')) files.push(target);
    }
  };
  visit(packageRoot);

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of source.matchAll(/(?:from|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      const value = specifier[1];
      if (!value.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), value);
      assert.equal(resolved.startsWith(`${packageRoot}${path.sep}`), true, `${file} imports ${value}`);
    }
  }
});
