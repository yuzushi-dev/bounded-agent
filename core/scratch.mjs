import fs from 'node:fs';
import path from 'node:path';

const RUN_ID = /^run_[a-f0-9]{24}$/;

function privateDirectory(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root
    || (stat.mode & 0o022) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('bounded scratch root is unsafe');
  }
}

function confined(root, name) {
  const target = path.join(root, name);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('bounded scratch path escaped root');
  return target;
}

export function scratchPaths(root, runId) {
  if (!RUN_ID.test(runId || '')) throw new Error('bounded scratch runId is invalid');
  return { root, stage: `.stage-${runId}`, job: `.job-${runId}` };
}

export function validateScratch(scratch, runId, expectedRoot) {
  if (!scratch || Object.keys(scratch).sort().join(',') !== 'job,root,stage'
    || typeof scratch.root !== 'string' || !path.isAbsolute(scratch.root)
    || path.normalize(scratch.root) !== scratch.root
    || scratch.stage !== `.stage-${runId}` || scratch.job !== `.job-${runId}`) {
    throw new Error('bounded scratch record is invalid');
  }
  const root = fs.realpathSync(scratch.root);
  if (root !== scratch.root || (expectedRoot && root !== fs.realpathSync(expectedRoot))) {
    throw new Error('bounded scratch root is invalid');
  }
  privateDirectory(root);
  for (const name of [scratch.stage, scratch.job]) {
    const target = confined(root, name);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory()
      || (stat.mode & 0o022) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) {
      throw new Error('bounded scratch path is unsafe');
    }
  }
  return { root, stage: scratch.stage, job: scratch.job };
}

export function assertScratchAbsent(scratch) {
  for (const name of [scratch.stage, scratch.job]) {
    if (fs.lstatSync(confined(scratch.root, name), { throwIfNoEntry: false })) {
      throw new Error('bounded scratch path already exists');
    }
  }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function cleanupScratch(scratch, runId, expectedRoot) {
  const validated = validateScratch(scratch, runId, expectedRoot);
  for (const name of [validated.stage, validated.job]) {
    const target = confined(validated.root, name);
    if (!fs.lstatSync(target, { throwIfNoEntry: false })) continue;
    fs.rmSync(target, { recursive: true });
    syncDirectory(validated.root);
  }
}
