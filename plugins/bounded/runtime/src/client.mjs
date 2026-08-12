import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { decodeResponse, encodeMessage, PROTOCOL_VERSION } from './protocol.mjs';

const runtimeBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/bounded-runtime.mjs');

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function waitForSocket(socketPath) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { return await connect(socketPath); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error('bounded runtime is unavailable');
}

function startRuntime(stateRoot, socketPath) {
  const child = spawn(process.execPath, [runtimeBin, 'serve', '--state-root', stateRoot, '--socket', socketPath], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: stateRoot, BOUNDED_STATE_ROOT: stateRoot },
  });
  child.unref();
}

export async function runtimeRequest({ stateRoot, socketPath = path.join(stateRoot, 'runtime.sock'), clientId, method, params }) {
  let socket;
  try { socket = await connect(socketPath); } catch {
    startRuntime(stateRoot, socketPath);
    socket = await waitForSocket(socketPath);
  }
  const id = `request-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      socket.off('data', onData);
      try { resolve(decodeResponse(buffer.slice(0, index + 1))); } catch (error) { reject(error); }
    };
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.once('error', reject);
    socket.write(encodeMessage({ version: PROTOCOL_VERSION, id, clientId, method, params }));
  });
  socket.end();
  if (!response.ok) throw new Error(response.error?.message || 'bounded runtime request failed');
  return response.result;
}

export function defaultStateRoot(env = process.env) {
  const configured = env.BOUNDED_STATE_ROOT || env.PLUGIN_DATA;
  if (configured) return path.resolve(configured);
  return path.join(env.XDG_STATE_HOME || path.join(process.env.HOME || '.', '.local', 'state'), 'bounded');
}

export function readJsonFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('bounded contract file is unsafe');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
