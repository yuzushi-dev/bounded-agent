#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeController } from '../src/controller.mjs';
import {
  PROTOCOL_VERSION, decodeMessage, encodeResponse,
} from '../src/protocol.mjs';

const runtimeRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function rootFrom(args) {
  return option(args, '--state-root', process.env.BOUNDED_STATE_ROOT || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'bounded'));
}

function socketFrom(args, root) { return option(args, '--socket', path.join(root, 'runtime.sock')); }

async function dispatch(controller, request) {
  const params = request.params;
  if (request.method === 'plan') return controller.plan(params);
  if (request.method === 'approve') return controller.approve(params.runId, params);
  if (request.method === 'activate') return controller.activate(params.runId, params);
  if (request.method === 'status') return params.cwd ? controller.statusForCwd(params.cwd) : controller.status(params.runId);
  if (request.method === 'complete') return controller.complete(params.runId, params);
  if (request.method === 'rollback') return controller.rollback(params.runId, params);
  if (request.method === 'doctor') return controller.doctor();
  throw new Error('runtime method is unavailable');
}

function errorResponse(request, error) {
  return encodeResponse({
    version: PROTOCOL_VERSION, id: request?.id || 'invalid', ok: false,
    error: { code: error?.code || 'RUNTIME_ERROR', message: error instanceof Error ? error.message : 'runtime request failed' },
  });
}

async function serve(args) {
  const stateRoot = rootFrom(args);
  const socketPath = socketFrom(args, stateRoot);
  const controller = createRuntimeController({ stateRoot });
  await controller.reconcile();
  const existing = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('runtime socket is unsafe');
    fs.rmSync(socketPath);
  }
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        let request;
        try {
          request = decodeMessage(`${line}\n`);
          if (request.method === 'plan' && request.clientId !== request.params.clientId) throw new Error('plan client binding failed');
          const result = await dispatch(controller, request);
          socket.write(encodeResponse({ version: PROTOCOL_VERSION, id: request.id, ok: true, result }));
        } catch (error) { socket.write(errorResponse(request, error)); }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      fs.writeFileSync(path.join(stateRoot, 'runtime.pid'), `${process.pid}\n`, { mode: 0o600 });
      resolve();
    });
  });
  const close = () => {
    server.close(() => { fs.rmSync(socketPath, { force: true }); fs.rmSync(path.join(stateRoot, 'runtime.pid'), { force: true }); process.exit(0); });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  process.stdout.write(`${JSON.stringify({ status: 'ready', socket: socketPath })}\n`);
  await new Promise(() => {});
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'serve';
  const stateRoot = rootFrom(args);
  if (command === 'serve') return serve(args);
  const controller = createRuntimeController({ stateRoot });
  if (command === 'doctor') return process.stdout.write(`${JSON.stringify(await controller.doctor())}\n`);
  if (command === 'guard' || command === 'reconcile') return process.stdout.write(`${JSON.stringify(await controller.reconcile())}\n`);
  throw new Error('unknown bounded-runtime command');
}

main().catch((error) => {
  process.stderr.write(`bounded-runtime: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
});
