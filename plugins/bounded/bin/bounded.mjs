#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { runtimeRequest, defaultStateRoot, readJsonFile } from '../runtime/src/client.mjs';
import { installGuard } from '../runtime/src/guard.mjs';

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

function runId(options) {
  if (options['run-id']) return options['run-id'];
  if (options.contract) return readContract(options).runId;
  throw new Error('--run-id or --contract is required');
}

async function request(options, method, params) {
  return runtimeRequest({ stateRoot: stateRoot(options), clientId: params.clientId || clientId(options), method, params });
}

async function plan(options) {
  const scope = required(options, 'scope').split(',').map((value) => value.trim()).filter(Boolean);
  const currentClient = clientId(options);
  const currentSession = sessionId(options);
  let workerArgs = options['worker-args-json'] ? JSON.parse(options['worker-args-json']) : (options['worker-arg'] ? [options['worker-arg']] : ['-e', 'process.exit(0)']);
  if (!Array.isArray(workerArgs) || workerArgs.some((value) => typeof value !== 'string')) throw new Error('--worker-args-json must be a string array');
  const contract = await request(options, 'plan', {
    cwd: path.resolve(required(options, 'cwd')), clientId: currentClient, sessionId: currentSession,
    toolCallId: options['tool-call-id'] || `cli-${process.pid}-${Date.now()}`,
    trigger: { id: 'bounded-cli', value: 'operator plan' }, task: { id: 'task', value: required(options, 'task') },
    acceptanceCheck: { id: 'acceptance', value: required(options, 'acceptance') },
    boundedContext: { sessionPath: scope[0], readPaths: [], maxBytes: number(options, 'max-read-bytes') },
    writeScope: { paths: scope, patchPaths: [], maxFiles: scope.length },
    verifier: { id: 'bounded-runtime-verifier', digest: digest('bounded-runtime-verifier/v1') },
    worker: { command: options['worker-command'] || process.execPath, args: workerArgs },
    requiredGates: ['sandbox', 'trusted-state', 'verifier', 'external-effects-disabled'],
    budgets: {
      maxReadBytes: number(options, 'max-read-bytes'), maxArtifactBytes: number(options, 'max-artifact-bytes'),
      maxOutputBytes: number(options, 'max-output-bytes'), maxRequests: number(options, 'max-requests'), maxWorkers: 1,
    },
    delivery: { mode: 'local', outputPaths: scope, receiptPath: 'receipts/pending' },
    routing: { reviewerFamily: 'local', chains: [{ role: 'verify', family: 'local', selectors: ['local/runtime'] }] },
    retries: { request: 0, semantic: 0, transport: 0, worker: 0 },
    stopPolicy: { onFailure: options['on-failure'] || 'rollback', partialSuccess: 'block' },
    trustedStateDigest: digest('bounded-runtime-trusted-state/v1'), maxSeconds: number(options, 'max-seconds'),
  });
  if (options.output) outputCreateOnly(path.resolve(options.output), contract);
  return contract;
}

async function main() {
  const [command = 'doctor', ...tokens] = process.argv.slice(2);
  const options = parse(tokens);
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
