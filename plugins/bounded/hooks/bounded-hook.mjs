#!/usr/bin/env node

import fs from 'node:fs';

import { defaultStateRoot, runtimeRequest } from '../runtime/src/client.mjs';
import { decideTool } from '../runtime/src/policy.mjs';

function eventName(input) { return input?.hook_event_name ?? input?.hookEventName ?? input?.event_name; }
function cwd(input) { return typeof input?.cwd === 'string' ? input.cwd : process.cwd(); }
function sessionId(input) { return input?.session_id ?? input?.sessionId; }
function toolName(input) { return input?.tool_name ?? input?.toolName; }
function toolInput(input) { return input?.tool_input ?? input?.toolInput; }
function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}
function lifecycle(input) {
  const value = JSON.stringify(toolInput(input) ?? {});
  return /(?:bounded\.mjs|bounded-runtime\.mjs)\s+(?:plan|approve|activate|complete|rollback|doctor|guard|reconcile)\b/i.test(value);
}

async function statusFor(input) {
  return runtimeRequest({
    stateRoot: defaultStateRoot(), clientId: 'bounded-hook', method: 'status',
    params: { cwd: cwd(input) },
  });
}

async function main(input) {
  const type = eventName(input);
  if (!['SessionStart', 'PreToolUse', 'PostToolUse'].includes(type)) return undefined;
  if (type === 'PreToolUse' && lifecycle(input)) return deny('bounded lifecycle commands require an external terminal');
  let status;
  try { status = await statusFor(input); } catch (error) {
    if (type === 'PreToolUse') return deny(`bounded runtime unavailable: ${error instanceof Error ? error.message : 'request failed'}`);
    return undefined;
  }
  if (!status?.active) return undefined;
  if (type === 'SessionStart') {
    const sameSession = status.sessionId === sessionId(input);
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: sameSession
      ? `Bounded runtime active for ${status.runId}; worker execution is sandboxed and external effects are disabled until acceptance.`
      : `A bounded runtime run is active for another session (${status.sessionId}); this session is outside its adapter seam.` } };
  }
  if (type === 'PreToolUse') {
    if (status.sessionId !== sessionId(input)) return deny('bounded runtime session does not match');
    const decision = decideTool({ toolName: toolName(input), toolInput: toolInput(input), cwd: cwd(input), status, sessionId: sessionId(input) });
    return decision.allow ? undefined : deny(decision.reason);
  }
  return undefined;
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const result = await main(input);
  if (result !== undefined) process.stdout.write(JSON.stringify(result));
} catch (error) {
  if (eventName(input) === 'PreToolUse') process.stdout.write(JSON.stringify(deny(error instanceof Error ? error.message : 'bounded runtime rejected the event')));
  else { process.stderr.write(`bounded hook failed closed: ${error instanceof Error ? error.message : 'invalid input'}\n`); process.exitCode = 1; }
}
