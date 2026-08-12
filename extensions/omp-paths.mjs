import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

export function normalizeProfileName(value) {
  const profile = value?.trim();
  if (!profile || profile === 'default') return undefined;
  if (profile === '.' || profile === '..' || profile.endsWith('.')
    || !PROFILE.test(profile) || RESERVED.test(profile)) throw new Error('OMP profile is invalid');
  return profile;
}

function xdgRoot(env, platform, category, profile, defaultAgent) {
  if (!['linux', 'darwin'].includes(platform) || !defaultAgent) return undefined;
  const value = env[`XDG_${category.toUpperCase()}_HOME`];
  if (!value) return undefined;
  const root = path.join(value, 'omp');
  const candidate = profile ? path.join(root, 'profiles', profile) : root;
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function deriveOmpPaths({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || path.normalize(home) !== home) {
    throw new Error('home must be absolute');
  }
  const baseRoot = path.join(home, env.PI_CONFIG_DIR || '.omp');
  const profile = normalizeProfileName(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
  const ompRoot = profile ? path.join(baseRoot, 'profiles', profile) : baseRoot;
  let override = profile ? undefined : env.PI_CODING_AGENT_DIR;
  const legacyProfile = (() => { try { return normalizeProfileName(env.PI_PROFILE); } catch { return undefined; } })();
  if (legacyProfile && override === path.join(baseRoot, 'profiles', legacyProfile, 'agent')) override = undefined;
  const defaultAgent = path.join(ompRoot, 'agent');
  const agentRoot = override ? path.resolve(override) : defaultAgent;
  const usesDefaultAgent = agentRoot === defaultAgent;
  const dataRoot = xdgRoot(env, platform, 'data', profile, usesDefaultAgent) ?? ompRoot;
  const stateBase = xdgRoot(env, platform, 'state', profile, usesDefaultAgent) ?? agentRoot;
  return {
    ompRoot,
    agentRoot,
    pluginsRoot: path.join(dataRoot, 'plugins'),
    stateRoot: path.join(stateBase, 'omp-bounded'),
    systemdUnitDir: path.join(
      path.isAbsolute(env.XDG_CONFIG_HOME || '') ? env.XDG_CONFIG_HOME : path.join(home, '.config'),
      'systemd', 'user',
    ),
  };
}
