import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../skills/bounded-autonomy/SKILL.md', import.meta.url), 'utf8');
const document = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

test('frontmatter contains exact trigger-only metadata', () => {
  assert.ok(document, 'skill must have YAML frontmatter');
  assert.deepEqual(document[1].split('\n'), [
    'name: bounded-autonomy',
    'description: Use when a multi-step local task has a narrow filesystem scope and must finish within explicit time and resource limits.',
  ]);
  assert.ok(source.trim().split(/\s+/).length < 500, 'skill must stay under 500 words');
});

test('canonical command uses the parser contract and deterministic acceptance', () => {
  const commands = [...source.matchAll(/^\/bounded run .+$/gm)].map(([command]) => command);
  assert.equal(commands.length, 1, 'skill must define one canonical execution path');
  assert.deepEqual([...commands[0].matchAll(/(?:^| )(--[a-z-]+) (?:"[^"]*"|\S+)/g)].map((match) => match[1]), [
    '--task', '--acceptance', '--scope', '--max-seconds', '--max-read-bytes',
    '--max-artifact-bytes', '--max-output-bytes', '--max-requests',
    '--prohibited-effects', '--final-gate',
  ]);
  assert.match(commands[0], /--acceptance "node --test approval-console\/test_index\.test\.mjs exits with code 0"/);
  assert.doesNotMatch(commands[0], /tests pass|--max-workers/);
});

test('skill assigns fixed limits and confirmation to the correct actors', () => {
  assert.match(source, /`maxWorkers=1` is controller-fixed and is not an operator field\./);
  assert.match(source, /`--max-requests` is the controller-enforced worker and verifier request budget; set it to at least 2\./);
  assert.match(source, /The controller presents the exact preview; the human confirms it\./);
  assert.match(source, /The skill and model cannot confirm on the human's behalf\./);
});

test('skill keeps authority and external effects outside bounded execution', () => {
  assert.match(source, /`\/bounded` grants no permission and cannot bypass the controller\./);
  assert.match(source, /Do not invoke `\/bounded` for an external effect\./);
  assert.match(source, /Only prepare local artifacts, then stop for a separate human gate\./);
});
