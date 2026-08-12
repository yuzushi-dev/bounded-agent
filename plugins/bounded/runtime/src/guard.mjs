import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function safeAbsolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[%\n\r"\\]/.test(value)) {
    throw new Error(`${name} must be a safe absolute path`);
  }
}

export function renderGuardUnits({ nodePath, runtimePath = path.join(runtimeDirectory, 'bin', 'bounded-runtime.mjs'), stateRoot }) {
  safeAbsolute(nodePath, 'nodePath');
  safeAbsolute(runtimePath, 'runtimePath');
  safeAbsolute(stateRoot, 'stateRoot');
  const template = fs.readFileSync(path.join(runtimeDirectory, 'systemd', 'bounded-runtime-guard.service.in'), 'utf8');
  const service = template.replaceAll('@NODE_PATH@', nodePath).replaceAll('@RUNTIME_PATH@', runtimePath).replaceAll('@STATE_ROOT@', stateRoot);
  const timer = fs.readFileSync(path.join(runtimeDirectory, 'systemd', 'bounded-runtime-guard.timer'), 'utf8');
  return { service, timer };
}

export function installGuard({ configHome, nodePath = process.execPath, runtimePath, stateRoot }) {
  safeAbsolute(configHome, 'configHome');
  const target = path.join(configHome, 'systemd', 'user');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const { service, timer } = renderGuardUnits({ nodePath, runtimePath, stateRoot });
  const servicePath = path.join(target, 'bounded-runtime-guard.service');
  const timerPath = path.join(target, 'bounded-runtime-guard.timer');
  for (const [file, content] of [[servicePath, service], [timerPath, timer]]) {
    fs.writeFileSync(file, `${content.trim()}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  return { servicePath, timerPath };
}
