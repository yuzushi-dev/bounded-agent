import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INTEGRITY_FILES = [
  '.codex-plugin/plugin.json',
  'bin/bounded.mjs',
  'hooks/hooks.json',
  'hooks/bounded-hook.mjs',
  'src/contract.mjs',
  'src/integrity.mjs',
  'src/policy.mjs',
  'src/receipt.mjs',
  'src/state.mjs',
];
const DEFAULT_PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function pluginHookDigest(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  if (typeof pluginRoot !== 'string' || !path.isAbsolute(pluginRoot) || path.normalize(pluginRoot) !== pluginRoot) {
    throw new Error('plugin root is invalid');
  }
  const hash = crypto.createHash('sha256');
  for (const relative of INTEGRITY_FILES) {
    const file = path.join(pluginRoot, relative);
    const real = fs.realpathSync(file);
    if (real !== file) throw new Error(`plugin integrity file is unsafe: ${relative}`);
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function defaultPluginRoot() {
  return DEFAULT_PLUGIN_ROOT;
}
