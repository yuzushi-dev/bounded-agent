import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(MODULE_ROOT, '..');
const INSTALLATION_SCHEMA = 'bounded-global-installation/v1';
const DEFAULT_ADAPTERS = ['agent-plugins', 'codex', 'claude'];
const GUARD_TIMER = 'bounded-runtime-guard.timer';
const GUARD_SERVICE = 'bounded-runtime-guard.service';

const coreAdapterSources = Object.freeze({
  'agent-plugins': (root) => path.join(root, 'adapters', 'agent-plugins'),
  codex: (root) => path.join(root, 'plugins', 'bounded'),
  claude: (root) => path.join(root, 'adapters', 'claude'),
});

function adapterSources(root) {
  const result = { ...coreAdapterSources };
  const directory = path.join(root, 'adapters');
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && !Object.hasOwn(result, entry.name)) {
      result[entry.name] = (sourceRoot) => path.join(sourceRoot, 'adapters', entry.name);
    }
  }
  return result;
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function privateDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} is unsafe`);
  }
}

function ensureDirectory(directory, label) {
  absolute(directory, label);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
  fs.chmodSync(directory, 0o700);
  privateDirectory(directory, label);
}

function ensureParent(directory, label) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
}

function fileDigest(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function treeEntries(root, relative = '') {
  const entries = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const rel = path.join(relative, name);
    const full = path.join(root, rel);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`source contains a symbolic link: ${rel}`);
    if (stat.isDirectory()) entries.push(...treeEntries(root, rel));
    else if (stat.isFile()) entries.push(rel);
    else throw new Error(`source contains an unsupported file: ${rel}`);
  }
  return entries;
}

function treeDigest(root) {
  const hash = crypto.createHash('sha256');
  for (const relative of treeEntries(root)) {
    hash.update(relative.replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function copyTree(source, target) {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`source directory is invalid: ${source}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(source).sort()) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`source contains a symbolic link: ${path.relative(source, from)}`);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, (stat.mode & 0o111) ? 0o700 : 0o600);
    } else throw new Error(`source contains an unsupported file: ${from}`);
  }
}

function atomicWrite(file, content, mode = 0o600) {
  const directory = path.dirname(file);
  ensureParent(directory, `${path.basename(file)} parent`);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, 'wx', mode);
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function atomicSymlink(target, link) {
  const temporary = `${link}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.symlinkSync(target, temporary, 'dir');
  try { fs.renameSync(temporary, link); } finally { fs.rmSync(temporary, { force: true }); }
}

function readJson(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(`${label} is unsafe`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${label} is malformed`); }
}

function resolvedSystemctlPath(systemctlPath, env) {
  return systemctlPath || env.BOUNDED_SYSTEMCTL_PATH || 'systemctl';
}

function systemctl({ systemctlPath, run, env, args }) {
  const result = run(systemctlPath, args, { encoding: 'utf8', env });
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.error?.message || '').trim();
    throw new Error(`systemd user command failed (${args.join(' ')}): ${detail || `exit ${result?.status ?? 'unknown'}`}`);
  }
  return String(result.stdout || '').trim();
}

function enableGuard({ systemctlPath, run, env }) {
  systemctl({ systemctlPath, run, env, args: ['--user', 'daemon-reload'] });
  systemctl({ systemctlPath, run, env, args: ['--user', 'enable', '--now', GUARD_TIMER] });
}

function disableGuard({ systemctlPath, run, env }) {
  systemctl({ systemctlPath, run, env, args: ['--user', 'disable', '--now', GUARD_TIMER] });
  systemctl({ systemctlPath, run, env, args: ['--user', 'daemon-reload'] });
}

function guardRuntimeStatus({ platform, systemctlPath, run, env }) {
  if (platform !== 'linux') return { backend: 'launchd-user-advisory' };
  let enabled;
  try {
    enabled = systemctl({ systemctlPath, run, env, args: ['--user', 'is-enabled', GUARD_TIMER] });
  } catch (error) { throw new Error(`guard timer is disabled: ${error.message}`); }
  if (enabled !== 'enabled') throw new Error(`guard timer is disabled (${enabled || 'unknown'})`);
  let active;
  try {
    active = systemctl({ systemctlPath, run, env, args: ['--user', 'is-active', GUARD_TIMER] });
  } catch (error) { throw new Error(`guard timer is inactive: ${error.message}`); }
  if (active !== 'active') throw new Error(`guard timer is inactive (${active || 'unknown'})`);
  let serviceResult;
  try {
    serviceResult = systemctl({
      systemctlPath, run, env,
      args: ['--user', 'show', GUARD_SERVICE, '--property=Result', '--value'],
    });
  } catch (error) { throw new Error(`guard service status unavailable: ${error.message}`); }
  if (serviceResult !== 'success') throw new Error(`guard service failed (${serviceResult || 'unknown'})`);
  return { backend: 'systemd-user', timerEnabled: enabled, timerActive: active, serviceResult };
}

function sourceRootFor(sourceRoot) {
  const root = path.resolve(sourceRoot || SOURCE_ROOT);
  if (!fs.existsSync(path.join(root, 'plugins', 'bounded'))) throw new Error('bounded source package is unavailable');
  return root;
}

function packageVersion(sourceRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'plugins', 'bounded', '.codex-plugin', 'plugin.json'), 'utf8'));
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('bounded package version is invalid');
  return manifest.version;
}

function normalizeAdapters(adapters, sources) {
  const selected = adapters === undefined ? DEFAULT_ADAPTERS : adapters;
  if (!Array.isArray(selected)) throw new Error('adapters must be an array');
  const result = [...new Set(selected)];
  for (const name of result) if (!Object.hasOwn(sources, name)) throw new Error(`unknown adapter: ${name}`);
  return result;
}

function platformRoots({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const homeRoot = path.resolve(home);
  const xdg = (name, fallback) => path.resolve(env[name] || path.join(homeRoot, fallback));
  return {
    dataBase: xdg('XDG_DATA_HOME', '.local/share'),
    stateBase: xdg('XDG_STATE_HOME', '.local/state'),
    configBase: xdg('XDG_CONFIG_HOME', '.config'),
    binBase: path.join(homeRoot, '.local', 'bin'),
    platform,
    homeRoot,
  };
}

export function deriveGlobalPaths({ home = os.homedir(), env = process.env, version = '0.1.1', platform = process.platform } = {}) {
  const roots = platformRoots({ home, env, platform });
  const dataRoot = path.join(roots.dataBase, 'bounded');
  const stateRoot = path.join(roots.stateBase, 'bounded');
  const configRoot = path.join(roots.configBase, 'bounded');
  const versionRoot = path.join(dataRoot, version);
  const guard = platform === 'linux'
    ? {
      guardService: path.join(roots.configBase, 'systemd', 'user', 'bounded-runtime-guard.service'),
      guardTimer: path.join(roots.configBase, 'systemd', 'user', 'bounded-runtime-guard.timer'),
    }
    : { launchAgent: path.join(roots.homeRoot, 'Library', 'LaunchAgents', 'com.bounded.guard.plist') };
  return {
    dataRoot, stateRoot, configRoot, versionRoot,
    current: path.join(dataRoot, 'current'),
    manifest: path.join(configRoot, 'installation.json'),
    launcher: path.join(roots.binBase, 'bounded-agent'),
    platform,
    ...guard,
  };
}

function launcherSource(currentControl) {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(currentControl)}, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
  child.once('error', (error) => { process.stderr.write('bounded-agent: ' + error.message + '\\n'); process.exitCode = 1; });
child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
`;
}

function guardFiles(paths) {
  if (paths.platform === 'linux') return [
    { name: 'service', path: paths.guardService },
    { name: 'timer', path: paths.guardTimer },
  ];
  return [{ name: 'launchAgent', path: paths.launchAgent }];
}

function manifestFor({ paths, version, platform, adapters, runtimeDigest, adapterDigests, launcherDigest }) {
  const guard = guardFiles(paths).map(({ name, path: file }) => ({ name, path: file }));
  return {
    schema: INSTALLATION_SCHEMA,
    version,
    platform,
    backend: platform === 'linux' ? 'systemd-user' : 'launchd-user-advisory',
    runtime: { path: 'runtime', digest: runtimeDigest },
    adapters: adapters.map((name) => ({ name, path: `adapters/${name}`, digest: adapterDigests[name] })),
    guard: guard.map((item) => ({ ...item, digest: fileDigest(item.path) })),
    paths: {
      dataRoot: paths.dataRoot, stateRoot: paths.stateRoot, configRoot: paths.configRoot,
      versionRoot: paths.versionRoot, current: paths.current, launcher: paths.launcher, manifest: paths.manifest,
    },
    owned: [paths.versionRoot, paths.current, paths.launcher, paths.manifest, ...guard.map(({ path: file }) => file)],
    launcherDigest,
  };
}

function validateManifest(manifest) {
  if (!manifest || manifest.schema !== INSTALLATION_SCHEMA || typeof manifest.version !== 'string'
    || !manifest.paths || !Array.isArray(manifest.adapters) || !manifest.runtime) throw new Error('installation manifest is invalid');
  for (const [name, value] of Object.entries(manifest.paths)) absolute(value, `manifest path ${name}`);
  const guardPaths = Array.isArray(manifest.guard) ? manifest.guard.map(({ path: file }) => file) : [];
  if (manifest.owned?.join('|') !== [manifest.paths.versionRoot, manifest.paths.current, manifest.paths.launcher, manifest.paths.manifest, ...guardPaths].join('|')) {
    throw new Error('installation ownership is invalid');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(manifest.launcherDigest)) throw new Error('launcher digest is invalid');
  for (const item of [manifest.runtime, ...manifest.adapters]) {
    if (typeof item.path !== 'string' || item.path.startsWith('/') || !/^sha256:[0-9a-f]{64}$/.test(item.digest)) throw new Error('installation digest is invalid');
  }
  if (!Array.isArray(manifest.guard) || manifest.guard.length < 1) throw new Error('guard manifest is invalid');
  for (const item of manifest.guard) {
    absolute(item.path, `guard path ${item.name}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(item.digest)) throw new Error('guard digest is invalid');
  }
  return manifest;
}

function validateCurrent(manifest) {
  const { paths } = manifest;
  const current = fs.lstatSync(paths.current);
  if (!current.isSymbolicLink() || fs.realpathSync(paths.current) !== paths.versionRoot) throw new Error('current runtime link is invalid');
  if (treeDigest(path.join(paths.versionRoot, manifest.runtime.path)) !== manifest.runtime.digest) throw new Error('runtime digest mismatch');
  for (const adapter of manifest.adapters) {
    if (treeDigest(path.join(paths.versionRoot, adapter.path)) !== adapter.digest) throw new Error(`${adapter.name} adapter digest mismatch`);
  }
  if (fileDigest(paths.launcher) !== manifest.launcherDigest) throw new Error('launcher digest mismatch');
  for (const guard of manifest.guard) if (fileDigest(guard.path) !== guard.digest) throw new Error(`${guard.name} digest mismatch`);
}

export function globalDoctor({ manifestPath, systemctlPath, run = spawnSync, env = process.env } = {}) {
  if (!manifestPath) throw new Error('installation manifest path is required');
  const manifest = validateManifest(readJson(manifestPath, 'installation manifest'));
  validateCurrent(manifest);
  const guard = guardRuntimeStatus({
    platform: manifest.platform,
    systemctlPath: resolvedSystemctlPath(systemctlPath, env),
    run,
    env,
  });
  return { status: 'ready', version: manifest.version, platform: manifest.platform, adapters: manifest.adapters.map(({ name }) => name), guard };
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function guardContents({ root, paths, platform }) {
  const runtimePath = path.join(paths.current, 'runtime', 'runtime', 'bin', 'bounded-runtime.mjs');
  if (platform === 'linux') {
    const runtimeRoot = path.join(root, 'plugins', 'bounded', 'runtime', 'systemd');
    const service = fs.readFileSync(path.join(runtimeRoot, 'bounded-runtime-guard.service.in'), 'utf8')
      .replaceAll('@NODE_PATH@', process.execPath).replaceAll('@RUNTIME_PATH@', runtimePath).replaceAll('@STATE_ROOT@', paths.stateRoot);
    const timer = fs.readFileSync(path.join(runtimeRoot, 'bounded-runtime-guard.timer'), 'utf8');
    return new Map([[paths.guardService, `${service.trim()}\n`], [paths.guardTimer, `${timer.trim()}\n`]]);
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.bounded.guard</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(runtimePath)}</string><string>guard</string><string>--state-root</string><string>${xml(paths.stateRoot)}</string></array>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>15</integer>
</dict></plist>
`;
  return new Map([[paths.launchAgent, plist]]);
}

export function installGlobal({
  home = os.homedir(), env = process.env, sourceRoot, adapters, dryRun = false, platform = process.platform,
  systemctlPath, run = spawnSync,
} = {}) {
  const root = sourceRootFor(sourceRoot);
  const version = packageVersion(root);
  const sources = adapterSources(root);
  const selected = normalizeAdapters(adapters, sources);
  const paths = deriveGlobalPaths({ home, env, version, platform });
  const resolvedSystemctl = resolvedSystemctlPath(systemctlPath, env);
  const runtimeSource = path.join(root, 'plugins', 'bounded');
  const adapterSourcesResolved = Object.fromEntries(selected.map((name) => [name, sources[name](root)]));
  for (const source of [runtimeSource, ...Object.values(adapterSourcesResolved)]) {
    if (!fs.existsSync(source)) throw new Error(`adapter source is unavailable: ${source}`);
    if (!fs.lstatSync(source).isDirectory()) throw new Error(`adapter source is invalid: ${source}`);
  }
  const runtimeDigest = treeDigest(runtimeSource);
  const adapterDigests = Object.fromEntries(selected.map((name) => [name, treeDigest(adapterSourcesResolved[name])]));
  const launcher = launcherSource(path.join(paths.current, 'bin', 'bounded.mjs'));
  const launcherDigest = `sha256:${crypto.createHash('sha256').update(launcher).digest('hex')}`;
  if (dryRun) return { status: 'dry-run', version, adapters: selected, paths };

  ensureDirectory(paths.dataRoot, 'bounded data root');
  ensureDirectory(paths.stateRoot, 'bounded state root');
  ensureDirectory(paths.configRoot, 'bounded config root');
  ensureDirectory(path.dirname(paths.launcher), 'bounded launcher directory');
  const guard = guardContents({ root, paths, platform });
  if (fs.existsSync(paths.versionRoot) || fs.existsSync(paths.current) || fs.existsSync(paths.manifest)
    || [...guard.keys()].some((file) => fs.existsSync(file))) {
    throw new Error('bounded installation already exists; use uninstall before reinstalling this version');
  }

  const staging = path.join(paths.dataRoot, `.install-${version}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  let guardActivationStarted = false;
  let guardEnabled = false;
  try {
    copyTree(runtimeSource, path.join(staging, 'runtime'));
    for (const name of selected) copyTree(adapterSourcesResolved[name], path.join(staging, 'adapters', name));
    fs.mkdirSync(path.join(staging, 'bin'), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(root, 'scripts', 'global-install.mjs'), path.join(staging, 'bin', 'global-install.mjs'));
    fs.chmodSync(path.join(staging, 'bin', 'global-install.mjs'), 0o600);
    atomicWrite(path.join(staging, 'bin', 'bounded.mjs'), fs.readFileSync(path.join(root, 'scripts', 'bounded.mjs')));
    fs.renameSync(staging, paths.versionRoot);
    atomicSymlink(paths.versionRoot, paths.current);
    atomicWrite(paths.launcher, launcher, 0o755);
    for (const [file, content] of guard) atomicWrite(file, content);
    const manifest = manifestFor({ paths, version, platform, adapters: selected, runtimeDigest, adapterDigests, launcherDigest });
    atomicWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    if (platform === 'linux') {
      guardActivationStarted = true;
      enableGuard({ systemctlPath: resolvedSystemctl, run, env });
      guardEnabled = true;
    }
    globalDoctor({ manifestPath: paths.manifest, systemctlPath: resolvedSystemctl, run, env });
    return { status: 'installed', version, adapters: selected, paths };
  } catch (error) {
    if (guardActivationStarted || guardEnabled) {
      try { disableGuard({ systemctlPath: resolvedSystemctl, run, env }); } catch {}
    }
    fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(paths.manifest)) fs.rmSync(paths.manifest, { force: true });
    if (fs.existsSync(paths.launcher)) fs.rmSync(paths.launcher, { force: true });
    if (fs.existsSync(paths.current) && fs.lstatSync(paths.current).isSymbolicLink()) fs.rmSync(paths.current, { force: true });
    if (fs.existsSync(paths.versionRoot)) fs.rmSync(paths.versionRoot, { recursive: true, force: true });
    for (const file of guard.keys()) if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    throw error;
  }
}

export function uninstallGlobal({ manifestPath, systemctlPath, run = spawnSync, env = process.env } = {}) {
  const manifest = validateManifest(readJson(manifestPath, 'installation manifest'));
  if (path.resolve(manifestPath) !== manifest.paths.manifest) throw new Error('manifest path is not owned by this installation');
  validateCurrent(manifest);
  if (manifest.platform === 'linux') disableGuard({ systemctlPath: resolvedSystemctlPath(systemctlPath, env), run, env });
  const { paths } = manifest;
  fs.rmSync(paths.current, { force: true });
  fs.rmSync(paths.versionRoot, { recursive: true, force: true });
  fs.rmSync(paths.launcher, { force: true });
  for (const { path: file } of manifest.guard) fs.rmSync(file, { force: true });
  fs.rmSync(paths.manifest, { force: true });
  return { status: 'uninstalled', version: manifest.version };
}

export { INSTALLATION_SCHEMA };
