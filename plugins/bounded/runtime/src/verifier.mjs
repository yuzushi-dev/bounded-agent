import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from './contract.mjs';

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value && !value.split('/').some((part) => part === '.' || part === '..');
}

function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('verifier found a symlink');
    if (entry.isDirectory()) files.push(...listFiles(full, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error('verifier found a non-regular output');
  }
  return files;
}

export function verifyArtifacts(contract, stageRoot, artifacts) {
  const declared = contract.delivery.outputPaths;
  if (!Array.isArray(artifacts) || artifacts.length !== declared.length
    || artifacts.some((artifact) => !artifact || !safeRelative(artifact.path))) {
    return { valid: false, reason: 'artifact list is invalid' };
  }
  try {
    const listed = listFiles(stageRoot);
    if (listed.length !== declared.length || listed.some((relative) => !declared.includes(relative))) {
      return { valid: false, reason: 'undeclared output' };
    }
    const expected = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
    const verified = declared.map((relative) => {
      const target = path.join(stageRoot, ...relative.split('/'));
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('output is not a regular file');
      const bytes = fs.readFileSync(target);
      const artifact = expected.get(relative);
      if (!artifact || artifact.bytes !== bytes.length || artifact.digest !== sha256(bytes)) {
        throw new Error('artifact metadata does not match output');
      }
      return { path: relative, bytes: bytes.length, digest: sha256(bytes) };
    });
    const artifactBytes = verified.reduce((total, artifact) => total + artifact.bytes, 0);
    if (artifactBytes > contract.budgets.maxArtifactBytes) throw new Error('artifact budget exceeded');
    return { valid: true, artifacts: verified, artifactBytes };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

export function verifyAcceptance(contract, stageRoot, acceptance) {
  if (!acceptance?.passed || acceptance.digest !== contract.acceptanceCheck.digest) {
    return { valid: false, reason: 'acceptance proof is not bound to the contract check' };
  }
  const match = /^(\S+)\s+(contains|equals)\s+(.+)$/.exec(contract.acceptanceCheck.value);
  if (!match || !contract.delivery.outputPaths.includes(match[1])) {
    return { valid: false, reason: 'acceptance check is not a supported runtime assertion' };
  }
  const [relative, operator, expected] = match.slice(1);
  try {
    let current = stageRoot;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('acceptance output contains a symlink');
    }
    const stat = fs.lstatSync(current);
    if (!stat.isFile()) throw new Error('acceptance output is not a regular file');
    const actual = fs.readFileSync(current, 'utf8');
    const valid = operator === 'contains' ? actual.includes(expected) : actual === expected;
    return valid ? { valid: true } : { valid: false, reason: 'acceptance assertion failed' };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}
