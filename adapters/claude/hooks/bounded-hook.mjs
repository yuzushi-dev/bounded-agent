#!/usr/bin/env node

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

function eventName(input) { return input?.hook_event_name ?? input?.hookEventName ?? input?.event_name; }
function cwd(input) { return typeof input?.cwd === 'string' ? input.cwd : process.cwd(); }
function sessionId(input) { return input?.session_id ?? input?.sessionId; }
function toolName(input) { return input?.tool_name ?? input?.toolName; }
function toolInput(input) { return input?.tool_input ?? input?.toolInput; }
function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}
function lifecycle(input) {
  return /(?:bounded(?:\.mjs)?|bounded-runtime(?:\.mjs)?)\s+(?:plan|approve|activate|complete|rollback|doctor|guard|reconcile)\b/i.test(JSON.stringify(toolInput(input) ?? {}));
}
function external(input) {
  return /(?:\bgit\s+(?:push|fetch|pull|clone)|\b(?:curl|wget|ssh|scp|nc)\b|https?:\/\/|\b(?:publish|deploy|send|purchase)\b)/i.test(JSON.stringify(toolInput(input) ?? {}));
}
function cliStatus(input) {
  const args = ['status', '--cwd', cwd(input)];
  if (process.env.BOUNDED_STATE_ROOT) args.push('--state-root', process.env.BOUNDED_STATE_ROOT);
  const configured = process.env.BOUNDED_BIN || 'bounded';
  const command = configured.endsWith('.mjs') ? process.execPath : configured;
  const commandArgs = configured.endsWith('.mjs') ? [configured, ...args] : args;
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error(String(result.stderr || 'bounded runtime unavailable').trim());
  return JSON.parse(result.stdout);
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const type = eventName(input);
  if (!['SessionStart', 'PreToolUse', 'PostToolUse'].includes(type)) process.exit(0);
  if (type === 'PreToolUse' && lifecycle(input)) {
    process.stdout.write(JSON.stringify(deny('bounded lifecycle commands require an external terminal')));
    process.exit(0);
  }
  let status;
  try { status = cliStatus(input); }
  catch (error) {
    if (type === 'PreToolUse') process.stdout.write(JSON.stringify(deny(`bounded runtime unavailable: ${error.message}`)));
    process.exitCode = type === 'PreToolUse' ? 0 : 1;
    process.exit();
  }
  if (!status?.active) process.exit(0);
  if (type === 'SessionStart') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Bounded runtime active for ${status.runId}; worker execution is sandboxed and external effects are disabled until acceptance.` } }));
  } else if (type === 'PreToolUse') {
    if (lifecycle(input)) process.stdout.write(JSON.stringify(deny('bounded lifecycle commands require an external terminal')));
    else if (status.sessionId !== sessionId(input)) process.stdout.write(JSON.stringify(deny('bounded runtime session does not match')));
    else if (external(input)) process.stdout.write(JSON.stringify(deny('external effects are disabled')));
  }
} catch (error) {
  if (eventName(input) === 'PreToolUse') process.stdout.write(JSON.stringify(deny(error instanceof Error ? error.message : 'bounded hook rejected the event')));
  else { process.stderr.write(`bounded hook failed closed: ${error instanceof Error ? error.message : 'invalid input'}\n`); process.exitCode = 1; }
}
