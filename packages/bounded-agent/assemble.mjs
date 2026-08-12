#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const DEFAULT_DESTINATION = path.join(REPOSITORY_ROOT, 'dist', 'bounded-agent');
const PUBLIC_DESCRIPTION = 'Standalone bounded runtime and CLI for explicit local agent workflows.';
const PUBLIC_ADAPTERS = ['agent-plugins', 'claude', 'omp-ohmy-pi'];
const ASSEMBLY_MARKER = 'bounded-agent-assembly/v1';

function readVersion() {
  const file = path.join(REPOSITORY_ROOT, 'plugins', 'bounded', '.codex-plugin', 'plugin.json');
  const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('bounded version is invalid');
  return version;
}

function copyTree(source, destination) {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`source directory is invalid: ${source}`);
  fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const name of fs.readdirSync(source).sort()) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`source contains a symbolic link: ${path.relative(REPOSITORY_ROOT, from)}`);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, stat.mode & 0o777);
    } else throw new Error(`source contains an unsupported file: ${path.relative(REPOSITORY_ROOT, from)}`);
  }
}

function copyFile(source, destination) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`source file is invalid: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, stat.mode & 0o777);
}

function safeDestination(value) {
  const destination = path.resolve(value || DEFAULT_DESTINATION);
  if (destination === REPOSITORY_ROOT || destination === PACKAGE_ROOT || destination.startsWith(`${REPOSITORY_ROOT}${path.sep}packages${path.sep}`)) {
    throw new Error('assembly destination is not writable');
  }
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw new Error('assembly destination is unsafe');
  if (existing) {
    const manifestPath = path.join(destination, 'package.json');
    const manifest = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
    let owned = false;
    if (manifest?.isFile() && !manifest.isSymbolicLink()) {
      try {
        owned = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).boundedAgentAssembly === ASSEMBLY_MARKER;
      } catch {}
    }
    if (!owned) throw new Error('assembly destination must be a previous bounded-agent assembly');
  }
  return destination;
}

function packageManifest() {
  return {
    name: 'bounded-agent',
    boundedAgentAssembly: ASSEMBLY_MARKER,
    version: readVersion(),
    description: PUBLIC_DESCRIPTION,
    license: 'MIT',
    type: 'module',
    engines: { node: '>=22.22.0 <23' },
    bin: { 'bounded-agent': 'scripts/bounded.mjs' },
    files: ['scripts', 'plugins/bounded', 'adapters'],
  };
}

export function assemblePublicPackage(destination = DEFAULT_DESTINATION) {
  const output = safeDestination(destination);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.bounded-agent-'));
  let backup;
  try {
    fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(packageManifest(), null, 2)}\n`, { mode: 0o644 });
    copyFile(path.join(PACKAGE_ROOT, 'README.md'), path.join(staging, 'README.md'));
    copyFile(path.join(PACKAGE_ROOT, 'LICENSE'), path.join(staging, 'LICENSE'));
    copyFile(path.join(REPOSITORY_ROOT, 'scripts', 'bounded.mjs'), path.join(staging, 'scripts', 'bounded.mjs'));
    copyFile(path.join(REPOSITORY_ROOT, 'scripts', 'global-install.mjs'), path.join(staging, 'scripts', 'global-install.mjs'));
    copyTree(path.join(REPOSITORY_ROOT, 'plugins', 'bounded'), path.join(staging, 'plugins', 'bounded'));
    for (const name of PUBLIC_ADAPTERS) {
      copyTree(path.join(REPOSITORY_ROOT, 'adapters', name), path.join(staging, 'adapters', name));
    }
    backup = path.join(path.dirname(output), `.${path.basename(output)}.previous-${process.pid}-${Date.now()}`);
    if (fs.existsSync(output)) fs.renameSync(output, backup);
    fs.renameSync(staging, output);
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    backup = undefined;
    return output;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (backup && fs.existsSync(backup) && !fs.existsSync(output)) fs.renameSync(backup, output);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${assemblePublicPackage(process.argv[2] || DEFAULT_DESTINATION)}\n`);
  } catch (error) {
    process.stderr.write(`bounded-agent assembly: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  }
}
