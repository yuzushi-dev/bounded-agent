#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { runtimeRequest, defaultStateRoot, readJsonFile } from '../runtime/src/client.mjs';
import { installGuard } from '../runtime/src/guard.mjs';
import { buildExecutionProtocol, buildVerifierBrief, validateVerifierResult } from '../src/protocol.mjs';

function parse(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function required(options, name) {
  if (!options[name]) throw new Error(`--${name} is required`);
  return options[name];
}

function number(options, name) {
  const value = Number(required(options, name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function optionalNumber(options, name, fallback) {
  if (!options[name]) return fallback;
  const value = Number(options[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function csv(value = '') { return value.split(',').map((item) => item.trim()).filter(Boolean); }
function json(value, fallback) { return value ? JSON.parse(value) : fallback; }
function stateRoot(options) { return path.resolve(options['state-root'] || defaultStateRoot()); }
function clientId(options) { return options['client-id'] || process.env.BOUNDED_CLIENT_ID || 'bounded-cli'; }
function sessionId(options) { return options['session-id'] || process.env.BOUNDED_SESSION_ID || 'bounded-cli-session'; }
function digest(value) { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`; }

function outputCreateOnly(target, value) {
  if (!path.isAbsolute(target) || path.normalize(target) !== target) throw new Error('output path must be absolute and normalized');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(path.dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Error('output parent is unsafe');
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); } finally { fs.closeSync(fd); }
}

function readContract(options) { return readJsonFile(path.resolve(required(options, 'contract'))); }
function readProtocol(options) { return readJsonFile(path.resolve(required(options, 'protocol'))); }

function runId(options) {
  if (options['run-id']) return options['run-id'];
  if (options.contract) return readContract(options).runId;
  throw new Error('--run-id or --contract is required');
}

async function request(options, method, params) {
  return runtimeRequest({ stateRoot: stateRoot(options), clientId: params.clientId || clientId(options), method, params });
}

function prepare(options) {
  const protocol = buildExecutionProtocol({
    task: required(options, 'task'),
    host: options.host || 'codex',
    modelTiers: json(options['model-tiers-json'], {}),
    writePaths: csv(required(options, 'scope')),
    readPaths: csv(options['read-scope']),
    acceptance: csv(required(options, 'acceptance')),
    unresolvedDecisions: csv(options['unresolved']),
    riskFlags: csv(options['risk']),
    strategy: options.strategy,
    assurance: options.assurance,
    laneCount: optionalNumber(options, 'lane-count', 1),
    lanes: json(options['lanes-json'], []),
    evidence: csv(options.evidence),
    effects: json(options['effects-json'], undefined),
    limits: {
      maxSeconds: optionalNumber(options, 'max-seconds', undefined),
      maxRequests: optionalNumber(options, 'max-requests', undefined),
      maxReadBytes: optionalNumber(options, 'max-read-bytes', undefined),
      maxArtifactBytes: optionalNumber(options, 'max-artifact-bytes', undefined),
      maxOutputBytes: optionalNumber(options, 'max-output-bytes', undefined),
    },
  });
  if (options.output) outputCreateOnly(path.resolve(options.output), protocol);
  return protocol;
}

async function planFromValues(options, values) {
  const scope = values.scope;
  const currentClient = clientId(options);
  const currentSession = sessionId(options);
  const workerArgs = options['worker-args-json'] ? JSON.parse(options['worker-args-json']) : (options['worker-arg'] ? [options['worker-arg']] : ['-e', 'process.exit(0)']);
  if (!Array.isArray(workerArgs) || workerArgs.some((value) => typeof value !== 'string')) throw new Error('--worker-args-json must be a string array');
  const contract = await request(options, 'plan', {
    cwd: path.resolve(required(options, 'cwd')), clientId: currentClient, sessionId: currentSession,
    toolCallId: options['tool-call-id'] || `cli-${process.pid}-${Date.now()}`,
    trigger: { id: 'bounded-cli', value: values.trigger || 'operator plan' }, task: { id: 'task', value: values.task },
    acceptanceCheck: { id: 'acceptance', value: values.acceptance },
    boundedContext: { sessionPath: scope[0], readPaths: values.readPaths || [], maxBytes: values.maxReadBytes },
    writeScope: { paths: scope, patchPaths: [], maxFiles: scope.length },
    verifier: { id: 'bounded-runtime-verifier', digest: digest('bounded-runtime-verifier/v2') },
    worker: { command: options['worker-command'] || process.execPath, args: workerArgs },
    requiredGates: ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled'],
    budgets: {
      maxReadBytes: values.maxReadBytes, maxArtifactBytes: values.maxArtifactBytes,
      maxOutputBytes: values.maxOutputBytes, maxRequests: values.maxRequests, maxWorkers: values.maxWorkers || 1,
    },
    delivery: { mode: 'local', outputPaths: scope, receiptPath: 'receipts/pending' },
    routing: { reviewerFamily: 'local', chains: [{ role: 'verify', family: 'local', selectors: ['local/runtime'] }] },
    retries: { request: 0, semantic: 0, transport: 0, worker: 0 },
    stopPolicy: { onFailure: options['on-failure'] || 'rollback', partialSuccess: 'block' },
    trustedStateDigest: digest('bounded-runtime-trusted-state/v1'), maxSeconds: values.maxSeconds,
  });
  if (options.output) outputCreateOnly(path.resolve(options.output), contract);
  return contract;
}

async function plan(options) {
  const scope = csv(required(options, 'scope'));
  return planFromValues(options, {
    task: required(options, 'task'),
    acceptance: required(options, 'acceptance'),
    scope,
    readPaths: [],
    maxReadBytes: number(options, 'max-read-bytes'),
    maxArtifactBytes: number(options, 'max-artifact-bytes'),
    maxOutputBytes: number(options, 'max-output-bytes'),
    maxRequests: number(options, 'max-requests'),
    maxSeconds: number(options, 'max-seconds'),
    maxWorkers: 1,
  });
}

async function planProtocol(options) {
  const protocol = readProtocol(options);
  if (protocol.mustAskUser) throw new Error(`protocol has unresolved decisions: ${protocol.unresolvedDecisions.join('; ')}`);
  if (protocol.assurance?.level === 'L3' && protocol.lanes?.length > 1) {
    throw new Error('L3 multi-lane execution must be dispatched by the host adapter; runtime plan-protocol accepts one worker scope');
  }
  return planFromValues(options, {
    trigger: `bounded execution protocol ${protocol.assurance.level}`,
    task: protocol.task,
    acceptance: protocol.acceptance.map(({ id, value }) => `${id}: ${value}`).join(' | '),
    scope: protocol.scope.writePaths,
    readPaths: protocol.scope.readPaths,
    maxReadBytes: protocol.limits.maxReadBytes,
    maxArtifactBytes: protocol.limits.maxArtifactBytes,
    maxOutputBytes: protocol.limits.maxOutputBytes,
    maxRequests: protocol.limits.maxRequests,
    maxSeconds: protocol.limits.maxSeconds,
    maxWorkers: 1,
  });
}

function verifierBrief(options) {
  const protocol = readProtocol(options);
  return buildVerifierBrief(protocol, {
    diffSummary: options['diff-summary'] || '',
    testEvidence: options['test-evidence'] || '',
    runtimeEvidence: options['runtime-evidence'] || '',
  });
}

function verifyResult(options) {
  const protocol = readProtocol(options);
  const result = readJsonFile(path.resolve(required(options, 'result-file')));
  return validateVerifierResult(protocol, result);
}

async function main() {
  const [command = 'doctor', ...tokens] = process.argv.slice(2);
  const options = parse(tokens);
  if (command === 'prepare') return prepare(options);
  if (command === 'plan-protocol') return planProtocol(options);
  if (command === 'verifier-brief') return verifierBrief(options);
  if (command === 'verify-result') return verifyResult(options);
  if (command === 'plan') return plan(options);
  if (command === 'doctor') return request(options, 'doctor', {});
  if (command === 'install-guard') {
    return installGuard({ configHome: path.resolve(required(options, 'config-home')), stateRoot: stateRoot(options), runtimePath: path.resolve(options['runtime-path'] || new URL('../runtime/bin/bounded-runtime.mjs', import.meta.url).pathname) });
  }
  if (command === 'approve') {
    const contract = readContract(options);
    return request(options, 'approve', { runId: contract.runId, contractDigest: contract.digest, clientId: contract.clientId,
      sessionId: contract.sessionId, operatorProof: options['operator-proof'] || 'operator-confirmed-external-cli', counter: 1 });
  }
  if (command === 'activate') {
    const contract = readContract(options);
    return request(options, 'activate', { runId: contract.runId, contractDigest: contract.digest, clientId: contract.clientId,
      sessionId: contract.sessionId, counter: 2 });
  }
  if (command === 'status' && options.cwd) return request(options, 'status', { cwd: path.resolve(options.cwd) });
  const id = runId(options);
  if (command === 'status') return request(options, 'status', { runId: id });
  if (command === 'rollback') {
    const contract = options.contract ? readContract(options) : null;
    const status = await request(options, 'status', { runId: id });
    return request(options, 'rollback', { runId: id, contractDigest: contract?.digest || status.contractDigest,
      clientId: contract?.clientId || status.clientId, sessionId: contract?.sessionId || status.sessionId,
      leaseId: options['lease-id'] || status.leaseId, counter: status.counter + 1, reason: options.reason || 'operator rollback' });
  }
  if (command === 'complete') {
    const contract = options.contract ? readContract(options) : null;
    const status = await request(options, 'status', { runId: id });
    const reference = required(options, 'acceptance-ref');
    return request(options, 'complete', { runId: id, contractDigest: contract?.digest || status.contractDigest,
      clientId: contract?.clientId || status.clientId, sessionId: contract?.sessionId || status.sessionId,
      leaseId: options['lease-id'] || status.leaseId, counter: status.counter + 1,
      acceptance: { passed: required(options, 'result') === 'accepted', digest: contract?.acceptanceCheck?.digest, reference }, });
  }
  throw new Error(`unknown bounded command: ${command}`);
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`bounded: ${error instanceof Error ? error.message : 'request failed'}\n`);
  process.exitCode = 1;
}
