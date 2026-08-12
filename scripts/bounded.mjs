#!/usr/bin/env node

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveGlobalPaths, globalDoctor, installGlobal, uninstallGlobal } from './global-install.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLED_ROOT = fs.existsSync(path.join(HERE, '..', 'runtime')) ? path.resolve(HERE, '..') : null;
const SOURCE_ROOT = INSTALLED_ROOT || path.resolve(HERE, '..');

function value(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
}

function adapters(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === '--adapter') {
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--adapter requires a name');
    result.push(args[++index]);
  }
  return result.length ? result : undefined;
}

function manifestPath() {
  return deriveGlobalPaths({ env: process.env }).manifest;
}

function runtimeCli() {
  return INSTALLED_ROOT ? path.join(INSTALLED_ROOT, 'runtime', 'bin', 'bounded.mjs') : path.join(SOURCE_ROOT, 'plugins', 'bounded', 'bin', 'bounded.mjs');
}

function print(valueToPrint) { process.stdout.write(`${JSON.stringify(valueToPrint)}\n`); }

function runRuntime(args) {
  const result = spawnSync(process.execPath, [runtimeCli(), ...args], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function main() {
  const [command = 'doctor', ...args] = process.argv.slice(2);
  if (command === 'install') {
    const result = installGlobal({
      sourceRoot: INSTALLED_ROOT ? undefined : SOURCE_ROOT,
      adapters: args.includes('--no-adapters') || args.includes('--runtime-only') ? [] : adapters(args),
      dryRun: args.includes('--dry-run'),
    });
    return print(result);
  }
  if (command === 'uninstall') return print(uninstallGlobal({ manifestPath: manifestPath() }));
  if (command === 'doctor') {
    if (fs.existsSync(manifestPath())) return print(globalDoctor({ manifestPath: manifestPath() }));
    return print({ status: 'not-installed' });
  }
  if (command === 'adapter' && args[0] === 'list') {
    const file = manifestPath();
    if (!fs.existsSync(file)) return print({ status: 'not-installed', adapters: [] });
    return print({ status: 'ready', adapters: JSON.parse(fs.readFileSync(file, 'utf8')).adapters.map(({ name }) => name) });
  }
  return runRuntime([command, ...args]);
}

try { main(); } catch (error) {
  process.stderr.write(`bounded: ${error instanceof Error ? error.message : 'command failed'}\n`);
  process.exitCode = 1;
}
