import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import { validateContract } from '../../core/contract.mjs';
import { sha256, stableSerialize } from '../../core/receipt.mjs';

const MAX_OUTPUT = 1024 * 1024;
const CREDENTIALS = {
  anthropic: [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_VERTEX_PROJECT_ID', 'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'GOOGLE_APPLICATION_CREDENTIALS',
  ],
  'openai-codex': ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'],
};

function privateRoot(root, name) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new Error(`${name} root is invalid`);
  }
  const real = fs.realpathSync(root);
  const stat = fs.lstatSync(real);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o002) !== 0) {
    throw new Error(`${name} root is unsafe`);
  }
  return real;
}

function snapshot(root) {
  const files = [];
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('audited root contains a symlink');
      if (entry.isDirectory()) visit(target, relative);
      else if (entry.isFile()) {
        const content = fs.readFileSync(target);
        files.push({ path: relative, bytes: content.length, digest: sha256(content) });
      } else throw new Error('audited root contains an unsupported entry');
    }
  }
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function tree(root) {
  const files = snapshot(root);
  return { files, digest: sha256(stableSerialize(files)) };
}

function timeout(promise, milliseconds) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cross-runtime verifier timed out')), milliseconds)),
  ]);
}

function commandResult(spec, env, roots, scratch, jobPath, limit, milliseconds,
  bwrapPath = '/usr/bin/bwrap', prlimitPath = '/usr/bin/prlimit', {
    writableStage = false, stageTarget, parseJson = true, family, credentialFile,
  } = {}) {
  if (!spec || typeof spec.command !== 'string' || !Array.isArray(spec.args)) throw new Error('verifier command is missing');
  let command;
  try { command = fs.realpathSync(spec.command); }
  catch { throw new Error('provider command failed (executable unavailable)'); }
  const covered = ['/usr/', '/bin/', '/lib/', '/lib64/'].some((root) => command.startsWith(root));
  const runner = covered ? command : '/runner';
  let credentialArgs = [];
  if (credentialFile !== undefined) {
    let credential;
    try { credential = fs.realpathSync(credentialFile); } catch { throw new Error('provider credential file is unavailable'); }
    const stat = fs.lstatSync(credential);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error('provider credential file is unsafe');
    }
    if (family === 'openai-codex') {
      credentialArgs = ['--dir', '/credentials', '--ro-bind', credential, '/credentials/auth.json', '--setenv', 'CODEX_HOME', '/credentials'];
    } else if (family === 'anthropic') {
      credentialArgs = ['--dir', '/home', '--dir', '/home/verifier', '--dir', '/home/verifier/.claude',
        '--ro-bind', credential, '/home/verifier/.claude/.credentials.json'];
    } else throw new Error('provider credential family is invalid');
  }
  const runtimeFiles = ['/etc/ld.so.cache', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/gai.conf', '/etc/passwd', '/etc/group'];
  const extraRuntime = (spec.runtimeMounts || []).flatMap(({ source, target }) => {
    if (typeof source !== 'string' || typeof target !== 'string' || !path.isAbsolute(source) || !path.isAbsolute(target)
      || ['/audit', '/scratch', '/work', '/delivery'].some((reserved) => target === reserved || target.startsWith(`${reserved}/`))) {
      throw new Error('provider runtime mount is invalid');
    }
    const real = fs.realpathSync(source);
    const stat = fs.lstatSync(real);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error('provider runtime mount is unsafe');
    return ['--ro-bind', real, target];
  });
  const args = [
    '--die-with-parent', '--unshare-all', '--share-net', '--new-session', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/lib', '/lib', ...(fs.existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
    ...runtimeFiles.filter(fs.existsSync).flatMap((file) => ['--ro-bind', file, file]),
    ...(fs.existsSync('/etc/ssl') ? ['--ro-bind', '/etc/ssl', '/etc/ssl'] : []),
    ...(covered ? [] : ['--ro-bind', command, '/runner']),
    ...extraRuntime,
    '--ro-bind', roots.base, '/audit/base', '--ro-bind', roots.source, '/audit/source',
    writableStage ? '--bind' : '--ro-bind', roots.stage, stageTarget || (writableStage ? '/work' : '/audit/stage'),
    '--bind', scratch, '/scratch', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--chdir', stageTarget || (writableStage ? '/work' : '/scratch'),
    '--clearenv', ...credentialArgs, '--setenv', 'HOME', '/home/verifier',
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'OMP_BOUNDED_JOB', '/scratch/job.json',
    '--', runner, ...spec.args,
  ];
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const credentialArgs = Object.entries(env).flatMap(([name, value]) => ['--setenv', name, value]);
    const child = spawn(prlimitPath, ['--cpu=30', '--as=4294967296', '--', bwrapPath, ...args.slice(0, args.indexOf('--clearenv') + 1), ...credentialArgs, ...args.slice(args.indexOf('--clearenv') + 1)], {
      cwd: scratch, detached: true, shell: false, env: { PATH: process.env.PATH || '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const kill = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    };
    const consume = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) { kill(); finish(new Error('verifier output cap exceeded')); return; }
      if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', consume('stdout'));
    child.stderr.on('data', consume('stderr'));
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code !== 0 || signal) {
        const detail = spec.debugOutput
          ? `: ${`${stderr}\n${stdout}`.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(-4000)}` : '';
        return finish(new Error(`provider command failed (${code ?? signal})${detail}`));
      }
      const metrics = {
        latencyMs: Date.now() - started,
        outputBytes: bytes,
        tokenUse: typeof spec.extractUsage === 'function' ? spec.extractUsage({ stdout, stderr }) : null,
      };
      if (!parseJson) return finish(null, { result: null, metrics, stdout, stderr });
      try {
        if (typeof spec.parseResult === 'function') return finish(null, {
          result: spec.parseResult({ stdout, stderr, scratch }), metrics,
        });
        if (typeof spec.resultFile === 'string') {
          const resultPath = path.join(scratch, spec.resultFile);
          if (path.dirname(resultPath) !== scratch) throw new Error('result file path is invalid');
          return finish(null, { result: JSON.parse(fs.readFileSync(resultPath, 'utf8')), metrics });
        }
        finish(null, { result: JSON.parse(stdout), metrics });
      } catch { finish(new Error('verifier result is not JSON')); }
    });
    timer = setTimeout(() => { kill(); finish(new Error('cross-runtime verifier timed out')); }, milliseconds);
  });
}

function exactResult(result, expected) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('strict verification result fields failed');
  if (Object.keys(result).sort().join(',') !== 'artifactDigest,contractDigest,findings,verdict,verifierFamily') throw new Error('strict verification result fields failed');
  if (result.contractDigest !== expected.contractDigest) throw new Error(`strict verification contract digest failed: ${result.contractDigest}`);
  if (result.artifactDigest !== expected.artifactDigest) throw new Error(`strict verification artifact digest failed: ${result.artifactDigest}`);
  if (result.verifierFamily !== expected.verifierFamily) throw new Error('strict verification family failed');
  if (!Array.isArray(result.findings)) throw new Error('strict verification findings failed');
  if (result.verdict === 'CLEAN' && result.findings.length !== 0) throw new Error('CLEAN verification has findings');
  if (result.verdict === 'CHANGES_REQUIRED' && result.findings.length === 0) throw new Error('CHANGES_REQUIRED verification has no findings');
  if (!['CLEAN', 'CHANGES_REQUIRED'].includes(result.verdict)) throw new Error('strict verification verdict failed');
  return result;
}

function envelopeDigest(envelope) {
  const unsigned = structuredClone(envelope);
  delete unsigned.envelopeDigest;
  return sha256(stableSerialize(unsigned));
}

const ENVELOPE_FIELDS = [
  'schema', 'runId', 'contractDigest', 'baseDigest', 'sourceDigest', 'writeScope',
  'resultingDiff', 'artifacts', 'artifactDigest', 'checks', 'executorFamily',
  'verifierFamily', 'createdAt', 'expiresAt', 'nonce', 'envelopeDigest',
].sort().join(',');

export function validateVerificationEnvelope(envelope, { contract, now, sourceRoot } = {}) {
  const findings = [];
  const add = (condition, code) => { if (!condition) findings.push({ code }); };
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { valid: false, findings: [{ code: 'envelope-type' }] };
  }
  add(Object.keys(envelope).sort().join(',') === ENVELOPE_FIELDS, 'fields');
  add(envelope.schema === 'omp-verification-envelope/v1', 'schema');
  add(envelope.runId === contract?.runId, 'run-id');
  add(envelope.contractDigest === sha256(stableSerialize(contract)), 'contract-digest');
  add(envelope.baseDigest && /^sha256:[a-f0-9]{64}$/.test(envelope.baseDigest), 'base-digest');
  add(envelope.sourceDigest && /^sha256:[a-f0-9]{64}$/.test(envelope.sourceDigest), 'source-digest');
  add(stableSerialize(envelope.writeScope) === stableSerialize(contract?.writeScope), 'write-scope');
  add(Array.isArray(envelope.resultingDiff), 'resulting-diff');
  add(Array.isArray(envelope.artifacts)
    && envelope.artifactDigest === sha256(stableSerialize(envelope.artifacts)), 'artifact-digest');
  add(Array.isArray(envelope.checks)
    && envelope.checks.every((check) => check && typeof check.name === 'string'
      && ['passed', 'failed'].includes(check.status)), 'checks');
  const task = contract?.routing?.chains?.find(({ role }) => role === 'task');
  const reviewer = contract?.routing?.chains?.find(({ role }) => role === 'reviewer');
  add(envelope.executorFamily === task?.family, 'executor-family');
  add(envelope.verifierFamily === reviewer?.family
    && envelope.verifierFamily === contract?.routing?.reviewerFamily
    && envelope.executorFamily !== envelope.verifierFamily, 'verifier-family');
  const created = Date.parse(envelope.createdAt);
  const expires = Date.parse(envelope.expiresAt);
  const observed = Date.parse(now ?? new Date().toISOString());
  add(Number.isFinite(created) && Number.isFinite(expires) && created <= expires
    && expires === Date.parse(contract?.expiresAt) && observed <= expires, 'freshness');
  add(typeof envelope.nonce === 'string' && /^[a-f0-9]{32}$/.test(envelope.nonce), 'nonce');
  add(envelope.envelopeDigest === envelopeDigest(envelope), 'envelope-digest');
  if (sourceRoot) {
    try { add(envelope.sourceDigest === tree(privateRoot(sourceRoot, 'source')).digest, 'source-drift'); }
    catch { findings.push({ code: 'source-drift' }); }
  }
  return { valid: findings.length === 0, findings };
}

function assertScope(stageRoot, writeScope) {
  const files = snapshot(stageRoot);
  const allowed = new Set([...(writeScope.paths || []), ...(writeScope.patchPaths || [])]);
  if (files.length !== allowed.size || files.some(({ path: file }) => !allowed.has(file))) {
    throw new Error(`resulting diff violates write scope: ${files.map(({ path: file }) => file).join(',') || '<empty>'}`);
  }
  return files;
}

function materializeProposal(proposal, stageRoot, contract) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)
    || Object.keys(proposal).join(',') !== 'artifacts' || !Array.isArray(proposal.artifacts)) {
    throw new Error('executor artifact proposal is invalid');
  }
  const allowed = new Set([...contract.writeScope.paths, ...contract.writeScope.patchPaths]);
  let bytes = 0;
  const seen = new Set();
  for (const artifact of proposal.artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
      || Object.keys(artifact).sort().join(',') !== 'content,path'
      || typeof artifact.path !== 'string' || !allowed.has(artifact.path) || seen.has(artifact.path)
      || typeof artifact.content !== 'string') throw new Error('executor artifact proposal violates write scope');
    seen.add(artifact.path);
    bytes += Buffer.byteLength(artifact.content);
    if (bytes > contract.budgets.maxArtifactBytes) throw new Error('executor artifact proposal exceeds budget');
    const target = path.join(stageRoot, artifact.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, artifact.content, { mode: 0o600, flag: 'wx' });
  }
}

function credentialEnv(family, configured, names) {
  const allow = names || CREDENTIALS[family] || [];
  if (allow.some((name) => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new Error('verifier credential allowlist is invalid');
  }
  return Object.fromEntries(allow.filter((name) => configured?.[name] !== undefined).map((name) => [name, configured[name]]));
}

export async function runSpike(options) {
  const {
    contract, baseRoot, sourceRoot, deliveryRoot, execute, executorCommand, verify, verifierCommand,
    now = new Date().toISOString(), timeoutMs = 30_000, outputCap = MAX_OUTPUT,
  } = options || {};
  const report = validateContract(contract, { now });
  if (!report.valid) throw new Error(`invalid or stale contract: ${report.findings.map(({ code }) => code).join(',')}`);
  if ((typeof execute !== 'function' && !executorCommand)
    || (typeof execute === 'function' && executorCommand)
    || (typeof verify !== 'function' && !verifierCommand)
    || (typeof verify === 'function' && verifierCommand)) throw new Error('exactly one executor and verifier are required');
  if (options.executorSelector !== undefined) throw new Error('lane selection is host-owned');
  const task = contract.routing.chains.find(({ role }) => role === 'task');
  const reviewer = contract.routing.chains.find(({ role }) => role === 'reviewer');
  if (!task || !reviewer || contract.routing.reviewerFamily !== reviewer.family || task.family === reviewer.family) {
    throw new Error('verifier must use an opposite provider family');
  }
  if (options.executorFamily !== undefined && options.executorFamily !== task.family) throw new Error('executor lane selection is host-owned');
  const base = privateRoot(baseRoot, 'base');
  const source = privateRoot(sourceRoot, 'source');
  const delivery = privateRoot(deliveryRoot, 'delivery');
  if (base === delivery || source === delivery || base === source) throw new Error('audited roots must be separate');
  const beforeBase = tree(base);
  const beforeSource = tree(source);
  if (options.sourceDigests && sha256(stableSerialize(options.sourceDigests)) !== sha256(stableSerialize(Object.fromEntries(beforeSource.files.map((item) => [item.path, item.digest]))))) {
    throw new Error('source drift detected');
  }
  const scratch = fs.mkdtempSync(path.join(path.dirname(base), '.scratch-'));
  fs.chmodSync(scratch, 0o700);
  const stageRoot = path.join(scratch, 'stage');
  const verifierRoot = path.join(scratch, 'verifier');
  fs.mkdirSync(stageRoot, { mode: 0o700 });
  fs.mkdirSync(verifierRoot, { mode: 0o700 });
  const startedAt = now;
  const metrics = { executor: null, verifier: null };
  let executorOutput = '';
  try {
    if (options.executorSchema !== undefined) {
      if (!options.executorSchema || typeof options.executorSchema !== 'object' || Array.isArray(options.executorSchema)) {
        throw new Error('executor JSON schema is invalid');
      }
      fs.writeFileSync(path.join(verifierRoot, 'artifact-schema.json'),
        `${JSON.stringify(options.executorSchema)}\n`, { mode: 0o600 });
    }
    if (execute) {
      const executeStarted = Date.now();
      await timeout(Promise.resolve(execute({ contract, stageRoot, executorFamily: task.family })), timeoutMs);
      metrics.executor = { latencyMs: Date.now() - executeStarted, outputBytes: 0, tokenUse: null };
    } else {
      const executorEnv = credentialEnv(task.family, options.env || process.env, options.executorEnvNames);
      const execution = await commandResult(executorCommand, executorEnv, { base, source, stage: stageRoot }, verifierRoot,
        null, outputCap, timeoutMs, options.bwrapPath, options.prlimitPath, {
          stageTarget: '/work', parseJson: true, family: task.family,
          credentialFile: options.credentialFiles?.[task.family],
        });
      metrics.executor = execution.metrics;
      executorOutput = execution.stdout || '';
      materializeProposal(execution.result, stageRoot, contract);
    }
    let artifacts;
    try { artifacts = assertScope(stageRoot, contract.writeScope); }
    catch (error) {
      if (options.debugOutput && executorOutput) {
        const tail = executorOutput.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(-2000);
        throw new Error(`${error.message}; executor output: ${tail}`);
      }
      throw error;
    }
    const baseAfterExecution = tree(base);
    if (baseAfterExecution.digest !== beforeBase.digest) throw new Error('base drift detected');
    const expected = {
      contractDigest: sha256(stableSerialize(contract)),
      artifactDigest: sha256(stableSerialize(artifacts)),
      verifierFamily: reviewer.family,
    };
    const nonce = randomBytes(16).toString('hex');
    const envelope = {
      schema: 'omp-verification-envelope/v1', runId: contract.runId,
      contractDigest: expected.contractDigest, baseDigest: beforeBase.digest, sourceDigest: beforeSource.digest,
      writeScope: structuredClone(contract.writeScope),
      resultingDiff: artifacts.map((artifact) => ({
        path: artifact.path,
        before: beforeBase.files.find((item) => item.path === artifact.path)?.digest ?? null,
        after: artifact.digest,
      })),
      artifacts, artifactDigest: expected.artifactDigest,
      checks: structuredClone(options.executedChecks ?? [{ name: 'write-scope', status: 'passed' }]),
      executorFamily: task.family, verifierFamily: reviewer.family,
      createdAt: startedAt, expiresAt: contract.expiresAt, nonce: randomBytes(16).toString('hex'),
    };
    envelope.envelopeDigest = envelopeDigest(envelope);
    const envelopeReport = validateVerificationEnvelope(envelope, { contract, now });
    if (!envelopeReport.valid) throw new Error(`verification envelope is invalid: ${envelopeReport.findings.map(({ code }) => code).join(',')}`);
    const job = structuredClone(envelope);
    const jobPath = path.join(verifierRoot, 'job.json');
    fs.writeFileSync(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    if (options.verifierSchema !== undefined) {
      if (!options.verifierSchema || typeof options.verifierSchema !== 'object' || Array.isArray(options.verifierSchema)) {
        throw new Error('verifier JSON schema is invalid');
      }
      fs.writeFileSync(path.join(verifierRoot, 'result-schema.json'),
        `${JSON.stringify(options.verifierSchema)}\n`, { mode: 0o600 });
    }
    const env = credentialEnv(reviewer.family, options.env || process.env, options.verifierEnvNames);
    const verifierContext = {
      contract, envelope: structuredClone(envelope), auditedFiles: { base: beforeBase.files, source: beforeSource.files, stage: artifacts }, verifierFamily: reviewer.family, executorFamily: task.family,
      baseRoot: base, sourceRoot: source, deliveryRoot: delivery, scratchRoot: verifierRoot,
      verifierEnv: env, readOnly: true,
    };
    let rawResult;
    if (verify) {
      const verifyStarted = Date.now();
      rawResult = await timeout(Promise.resolve(verify(verifierContext)), timeoutMs);
      metrics.verifier = { latencyMs: Date.now() - verifyStarted, outputBytes: 0, tokenUse: null };
    } else {
      const verification = await commandResult(verifierCommand, env, { base, source, stage: stageRoot }, verifierRoot, jobPath,
          outputCap, timeoutMs, options.bwrapPath, options.prlimitPath, {
            family: reviewer.family, credentialFile: options.credentialFiles?.[reviewer.family],
          });
      rawResult = verification.result;
      metrics.verifier = verification.metrics;
    }
    const result = exactResult(rawResult, expected);
    const afterSource = tree(source);
    const afterBase = tree(base);
    if (afterSource.digest !== beforeSource.digest) throw new Error('source drift detected');
    if (afterBase.digest !== beforeBase.digest) throw new Error('base drift detected');
    const finalEnvelope = validateVerificationEnvelope(envelope, { contract, now, sourceRoot: source });
    if (!finalEnvelope.valid) throw new Error(`verification envelope drifted: ${finalEnvelope.findings.map(({ code }) => code).join(',')}`);
    return { envelope, verification: result, metrics };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
