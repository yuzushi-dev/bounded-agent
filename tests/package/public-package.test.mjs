import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assembler = path.join(repoRoot, 'packages', 'bounded-agent', 'assemble.mjs');

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', ...options });
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function assemble(destination) {
  const result = runNode([assembler, destination], { cwd: repoRoot });
  assert.equal(result.status, 0, result.stderr);
}

function files(root, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...files(root, rel));
    else {
      assert.equal(entry.isSymbolicLink(), false, rel);
      result.push(rel.split(path.sep).join('/'));
    }
  }
  return result;
}

function snapshot(root) {
  return Object.fromEntries(files(root).map((relative) => [relative, fs.readFileSync(path.join(root, relative), 'utf8')]));
}

function packFiles(root) {
  const result = runCommand(process.env.npm_execpath || 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout)[0].files.map(({ path: relative }) => relative);
}

function publicText(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('assembles a clean bounded-agent npm payload with an optional host adapter', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-agent-package-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-agent-package-'));
  try {
    const output = path.join(root, 'package');
    const repeat = path.join(other, 'package');
    assemble(output);
    assemble(repeat);

    const manifest = JSON.parse(publicText(output, 'package.json'));
    assert.equal(manifest.name, 'bounded-agent');
    assert.equal(manifest.version, '0.1.1');
    assert.notEqual(manifest.private, true);
    assert.equal(manifest.license, 'MIT');
    assert.match(publicText(output, 'LICENSE'), /Copyright \(c\) 2026 Bounded contributors/);
    assert.deepEqual(manifest.bin, { 'bounded-agent': 'scripts/bounded.mjs' });
    assert.doesNotMatch(JSON.stringify(manifest), /omp-bounded|ompBounded|\bOMP\b|oh-my-pi/i);
    assert.deepEqual(snapshot(output), snapshot(repeat));

    const packed = packFiles(output);
    const required = [
      'package.json', 'README.md', 'LICENSE', 'scripts/bounded.mjs', 'scripts/global-install.mjs',
      'plugins/bounded/.codex-plugin/plugin.json', 'plugins/bounded/bin/bounded.mjs',
      'plugins/bounded/src/protocol.mjs',
      'plugins/bounded/runtime/bin/bounded-runtime.mjs',
      'plugins/bounded/runtime/systemd/bounded-runtime-guard.service.in',
      'plugins/bounded/runtime/systemd/bounded-runtime-guard.timer',
      'plugins/bounded/skills/bounded-autonomy/SKILL.md',
      'adapters/agent-plugins/plugin.json', 'adapters/claude/.claude-plugin/plugin.json',
      'adapters/claude/agents/bounded-verifier.md',
      'adapters/omp-ohmy-pi/bounded-hook.mjs', 'adapters/omp-ohmy-pi/README.md',
    ];
    for (const relative of required) assert.ok(packed.includes(relative), relative);

    const excluded = [
      '.omp-plugin', 'core', 'extensions', 'spikes', 'systemd', 'tests', 'docs', 'skills',
      'adapters/omp.mjs', 'adapters/systemd.mjs', 'scripts/install.mjs', 'scripts/doctor.mjs',
      'scripts/uninstall.mjs', 'packages', 'assemble.mjs', 'package-lock.json',
    ];
    for (const relative of excluded) assert.equal(packed.some((file) => file === relative || file.startsWith(`${relative}/`)), false, relative);

    const checkout = repoRoot.replaceAll('\\', '/');
    for (const relative of packed) {
      const text = publicText(output, relative);
      assert.equal(text.includes(checkout), false, relative);
      assert.doesNotMatch(text, /(?:\/home\/[A-Za-z0-9._-]+|~\/\.codex)/i, relative);
      assert.doesNotMatch(text, /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|(?:sk|ghp|github_pat|npm|hf|glpat)-[A-Za-z0-9._-]{12,}|\bAKIA[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{20,}/, relative);
      if (!relative.startsWith('adapters/omp-ohmy-pi/')) {
        assert.doesNotMatch(text, /omp-bounded|ompBounded|\bOMP\b|oh-my-pi/i, relative);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('refuses to replace an unrelated existing assembly destination', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-agent-package-'));
  try {
    const output = path.join(root, 'package');
    const sentinel = path.join(output, 'keep.txt');
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sentinel, 'do not delete\n');
    const result = runNode([assembler, output], { cwd: repoRoot });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /assembly destination/i);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do not delete\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assembled CLI supports a clean-HOME install dry-run without checkout paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-agent-cli-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-agent-home-'));
  try {
    const output = path.join(root, 'package');
    assemble(output);
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_STATE_HOME: path.join(home, 'state'),
      XDG_CONFIG_HOME: path.join(home, 'config'),
    };
    const cli = path.join(output, 'scripts', 'bounded.mjs');
    const run = (args) => runNode([cli, ...args], { cwd: home, env });
    const dryRun = run(['install', '--dry-run']);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.deepEqual(JSON.parse(dryRun.stdout).adapters, ['agent-plugins', 'codex', 'claude']);
    assert.equal(dryRun.stdout.includes(repoRoot), false);

    const optional = run(['install', '--dry-run', '--adapter', 'omp-ohmy-pi']);
    assert.equal(optional.status, 0, optional.stderr);
    assert.deepEqual(JSON.parse(optional.stdout).adapters, ['omp-ohmy-pi']);
    assert.equal(fs.existsSync(path.join(home, 'data')), false);
    assert.equal(fs.existsSync(path.join(home, 'state')), false);
    assert.equal(fs.existsSync(path.join(home, 'config')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
