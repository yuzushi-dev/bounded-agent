import { sha256, stableSerialize } from '../core/receipt.mjs';

const MAX_RESULT_BYTES = 10 * 1024;
const ROLLBACK_SAFETY_REASON = 'Rollback failed; protected state is unverified. All OMP tools are blocked.';
// OMP task/eval spawn agents; hub can start or restart peer jobs and processes.
const GUARDED_DISPATCH_TOOLS = new Set(['task', 'eval', 'hub']);
const HOST_ADMISSION_FIELDS = [
  'boundedContext', 'verifier', 'requiredGates', 'retries', 'stopPolicy', 'routing', 'phase',
];
const RUN_FLAGS = new Set([
  'task', 'acceptance', 'scope', 'max-seconds', 'max-read-bytes', 'max-artifact-bytes',
  'max-output-bytes', 'max-requests', 'prohibited-effects', 'final-gate',
]);

function words(value) {
  const result = [];
  let token = '';
  let quote;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\') {
      if (index + 1 >= value.length) throw new Error('trailing escape');
      token += value[++index];
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) {
      if (token) { result.push(token); token = ''; }
    } else token += character;
  }
  if (quote) throw new Error('unterminated quote');
  if (token) result.push(token);
  return result;
}

function parseRun(tokens) {
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    if (!flag?.startsWith('--') || index + 1 >= tokens.length) throw new Error('run options require --name value pairs');
    const name = flag.slice(2);
    if (!RUN_FLAGS.has(name)) throw new Error(`unknown option --${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate option --${name}`);
    values[name] = tokens[index + 1];
  }
  return values;
}

function parseScope(value) {
  const paths = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!paths.length) throw new Error('writable paths are required');
  return paths;
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value || '')) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function cancelled(message = 'operator cancelled') {
  return Object.assign(new Error(message), { code: 'CANCELLED' });
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : cancelled();
}

async function required(values, name, title, ctx, signal) {
  throwIfAborted(signal);
  const value = values[name] ?? await ctx.ui.input(title, undefined, { signal });
  throwIfAborted(signal);
  if (value === undefined) throw Object.assign(new Error('operator cancelled'), { code: 'CANCELLED' });
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${title.toLowerCase()} is required`);
  return value.trim();
}

function admissionDefaults(value) {
  const plain = (item) => item && typeof item === 'object' && !Array.isArray(item);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...HOST_ADMISSION_FIELDS].sort().join(',')
    || !plain(value.boundedContext)
    || !plain(value.verifier)
    || !Array.isArray(value.requiredGates)
    || !plain(value.retries)
    || !plain(value.stopPolicy)
    || !plain(value.routing)
    || typeof value.phase !== 'string') {
    throw new Error('host admission defaults are unavailable or invalid');
  }
  try { return deepFreeze(structuredClone(value)); }
  catch { throw new Error('host admission defaults are unavailable or invalid'); }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isInactiveL3Status(value) {
  const keys = value !== null && typeof value === 'object' ? Reflect.ownKeys(value) : [];
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && keys.length === 3
    && keys.every((key) => typeof key === 'string')
    && keys.sort().join(',') === 'active,level,nextDeadline'
    && value.level === 'L3-narrow-write'
    && value.active === false
    && value.nextDeadline === null;
}

function jsonBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(String(value));
  if (bytes.length <= maxBytes) return String(value);
  let end = maxBytes;
  while (end > 0 && bytes.subarray(0, end).toString().endsWith('\uFFFD')) end -= 1;
  return bytes.subarray(0, end).toString();
}

function redactSecrets(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/("[^"]*(?:api[_-]?key|authorization|cookie|credential|password|secret|token)[^"]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/\b([A-Za-z0-9_-]*(?:api[_-]?key|authorization|cookie|credential|password|secret|token)[A-Za-z0-9_-]*\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._-]+\b/g, '[REDACTED]');
}

function sanitize(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (seen.has(value)) throw new Error('circular output');
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)$/i.test(key)
      ? '[REDACTED]'
      : sanitize(item, seen),
  ]));
}

function serialize(value) {
  let serialized;
  try { serialized = redactSecrets(typeof value === 'string' ? value : stableSerialize(sanitize(value))); }
  catch { serialized = '[unrenderable output]'; }
  return serialized;
}

function render(value, source = 'output') {
  const serialized = serialize(value);
  const footer = `\n\n[bounded adapter truncated ${source} at ${MAX_RESULT_BYTES} bytes]`;
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_RESULT_BYTES) return serialized;
  let budget = MAX_RESULT_BYTES - Buffer.byteLength(footer, 'utf8');
  let candidate = `${truncateUtf8(serialized, Math.max(0, budget))}${footer}`;
  while (Buffer.byteLength(candidate, 'utf8') > MAX_RESULT_BYTES && budget > 0) {
    candidate = `${truncateUtf8(serialized, --budget)}${footer}`;
  }
  return candidate;
}

function renderConfirmation(value) {
  let serialized;
  try { serialized = stableSerialize(value); }
  catch { throw new Error('confirmation is not serializable'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('confirmation exceeds the 10 KiB display limit');
  }
  return serialized;
}

function notify(ctx, value, type) {
  ctx.ui.notify(render(value, 'command output'), type);
}

function limitResult(event) {
  const original = Array.isArray(event?.content) ? event.content : [];
  const content = original.map((part) => part?.type === 'text' && typeof part.text === 'string'
    ? { ...part, text: render(part.text, `${event?.toolName || 'tool'} output`) }
    : part);
  if (jsonBytes(content) <= MAX_RESULT_BYTES) {
    return stableSerialize(content) === stableSerialize(original) ? undefined : { content };
  }
  const toolName = truncateUtf8(event?.toolName || 'tool', 256).replace(/[\u0000-\u001f\u007f]/g, ' ');
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  const envelope = (value) => [{ type: 'text', text: value }];
  let candidate = render(text, `${toolName} output`);
  while (jsonBytes(envelope(candidate)) > MAX_RESULT_BYTES && candidate) {
    candidate = truncateUtf8(candidate, Buffer.byteLength(candidate, 'utf8') - 1);
  }
  return { content: envelope(candidate) };
}

export function createOmpAdapter(controller, { hostAdmissionDefaults, loadHostAdmissionDefaults } = {}) {
  const defaults = hostAdmissionDefaults === undefined ? undefined : admissionDefaults(hostAdmissionDefaults);
  if (loadHostAdmissionDefaults !== undefined && typeof loadHostAdmissionDefaults !== 'function') {
    throw new Error('host admission defaults loader must be a function');
  }
  let degradedReason = 'reconciliation required';
  let safetyLatchReason;
  let commandSequence = 0;
  let activeOperation;
  return {
    register(pi) {
      pi.registerCommand('bounded', {
        description: 'Run and inspect deterministic bounded autonomy.',
        async handler(args, ctx) {
          let verb;
          let operation;
          try {
            const action = words(String(args ?? '').trim());
            verb = action.shift();
            if (!['run', 'status', 'rollback', 'doctor'].includes(verb) || (verb !== 'run' && action.length)) {
              throw new Error('usage: /bounded run|status|rollback|doctor');
            }
            if (verb !== 'run') {
              if (verb === 'rollback' && activeOperation) {
                operation = activeOperation;
                operation.rollingBack = true;
                operation.abort.abort(cancelled('operator rollback'));
                if (operation.running && operation.promise) {
                  try { await operation.promise; } catch {}
                }
              }
              const result = verb === 'rollback' ? await controller.rollback('operator') : await controller[verb]();
              if (verb === 'rollback') {
                if (result?.status !== 'protected') throw new Error('rollback did not verify protected state');
                safetyLatchReason = undefined;
                degradedReason = undefined;
              } else if (verb === 'status' && isInactiveL3Status(result)) {
                degradedReason = undefined;
              }
              notify(ctx, result, 'info');
              return;
            }
            if (activeOperation) throw new Error('another bounded command is active');
            if (safetyLatchReason) throw new Error(`adapter degraded: ${safetyLatchReason}`);
            if (degradedReason) throw new Error(`adapter degraded: ${degradedReason}`);
            if (ctx.hasUI !== true) throw new Error('/bounded run requires interactive OMP confirmation');
            if (ctx.isIdle() !== true) throw new Error('/bounded run requires an idle OMP session');
            const effectiveDefaults = defaults
              ?? admissionDefaults(await loadHostAdmissionDefaults?.());
            if (!effectiveDefaults) throw new Error('host admission defaults are unavailable or invalid');
            operation = { abort: new AbortController(), running: false, promise: undefined };
            activeOperation = operation;
            const { signal } = operation.abort;
            const values = parseRun(action);
            const task = await required(values, 'task', 'Exact outcome', ctx, signal);
            const acceptance = await required(values, 'acceptance', 'Acceptance check', ctx, signal);
            const scope = parseScope(await required(values, 'scope', 'Writable paths (comma-separated)', ctx, signal));
            const maxSeconds = positiveInteger(
              await required(values, 'max-seconds', 'Maximum duration in seconds (1-300)', ctx, signal),
              'maximum duration',
            );
            const budgets = {
              maxReadBytes: positiveInteger(await required(values, 'max-read-bytes', 'Maximum read bytes', ctx, signal), 'maximum read bytes'),
              maxArtifactBytes: positiveInteger(await required(values, 'max-artifact-bytes', 'Maximum artifact bytes', ctx, signal), 'maximum artifact bytes'),
              maxOutputBytes: positiveInteger(await required(values, 'max-output-bytes', 'Maximum output bytes', ctx, signal), 'maximum output bytes'),
              maxRequests: positiveInteger(await required(values, 'max-requests', 'Maximum requests (at least 2)', ctx, signal), 'maximum requests'),
              maxWorkers: 1,
            };
            const prohibitedEffects = await required(values, 'prohibited-effects', 'Prohibited effects (all external effects)', ctx, signal);
            const finalGate = await required(values, 'final-gate', 'Final human gate (human-approval)', ctx, signal);
            const literals = [task, acceptance, ...scope, prohibitedEffects, finalGate];
            if (literals.some((value) => redactSecrets(value) !== value)) {
              throw new Error('secrets are not allowed in /bounded input');
            }
            const request = {
              ...effectiveDefaults,
              toolCallId: `bounded-command-${++commandSequence}`,
              sessionId: ctx.sessionManager.getSessionId(),
              trigger: { id: 'bounded-command', value: '/bounded run' },
              task: { id: 'bounded-command-task', value: task },
              acceptanceCheck: { id: 'bounded-command-acceptance', value: acceptance },
              writeScope: { paths: scope, patchPaths: [], maxFiles: scope.length },
              budgets,
              maxSeconds,
              delivery: { mode: 'local', outputPaths: scope },
              externalEffects: { enabled: false, finalGate },
              prohibitedEffects,
            };
            const preview = {
              task,
              acceptance,
              scope,
              budgets,
              maxSeconds,
              prohibitedEffects,
              finalGate,
              request,
              requestDigest: sha256(stableSerialize(request)),
            };
            const confirmed = await ctx.ui.confirm(
              'Confirm bounded contract request',
              renderConfirmation(preview),
              { signal },
            );
            throwIfAborted(signal);
            if (!confirmed) {
              notify(ctx, 'bounded run cancelled', 'warning');
              return;
            }
            throwIfAborted(signal);
            const contract = await controller.admit(request);
            try {
              if (contract?.task?.digest !== sha256(task)
                || contract?.acceptanceCheck?.digest !== sha256(acceptance)
                || stableSerialize(contract.writeScope) !== stableSerialize(request.writeScope)
                || stableSerialize(contract.budgets) !== stableSerialize(request.budgets)
                || Date.parse(contract.expiresAt) - Date.parse(contract.createdAt) !== maxSeconds * 1000
                || !contract.requiredGates?.includes('external-effects-disabled')) {
                throw new Error('admitted contract does not bind the confirmed operator values');
              }
              notify(ctx, {
                contractDigest: sha256(stableSerialize(contract)),
                contract,
              }, 'info');
              throwIfAborted(signal);
              operation.running = true;
              operation.promise = controller.run(contract, { signal });
              const receipt = await operation.promise;
              notify(ctx, receipt, 'info');
            } finally {
              await controller.discard(contract);
            }
          } catch (error) {
            if (verb === 'rollback') safetyLatchReason = ROLLBACK_SAFETY_REASON;
            if (error?.code === 'CANCELLED') {
              notify(ctx, 'bounded run cancelled', 'warning');
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            notify(ctx, new Set([
              'staged artifact escaped write scope',
              'staged artifacts violate write scope',
              'artifact quota or write scope violated',
            ]).has(message)
              ? 'Scope widening rejected; start a new /bounded run contract.'
              : `bounded ${verb || 'command'} rejected: ${message}`, 'error');
          } finally {
            if (operation && activeOperation === operation && !operation.rollingBack) {
              activeOperation = undefined;
            } else if (verb === 'rollback' && operation && activeOperation === operation) {
              activeOperation = undefined;
            }
          }
        },
      });
      pi.on('tool_call', async (event) => {
        if (safetyLatchReason) return { block: true, reason: safetyLatchReason };
        if (activeOperation) return { block: true, reason: 'Bounded run active; all other OMP tools are blocked.' };
        return GUARDED_DISPATCH_TOOLS.has(event.toolName) ? {
          block: true,
          reason: degradedReason
            ? `Direct ${event.toolName} execution is outside the bounded safety boundary; adapter degraded: ${degradedReason}.`
            : `Direct ${event.toolName} execution is outside the bounded safety boundary; use /bounded.`,
        } : undefined;
      });
      pi.on('tool_result', async (event) => limitResult(event));
      for (const event of ['session_start', 'session_switch', 'session_branch', 'session_tree']) {
        pi.on(event, async () => {
          try {
            const result = await controller.status();
            if (isInactiveL3Status(result)) {
              degradedReason = undefined;
            } else {
              degradedReason = 'reconciliation did not verify inactive L3';
            }
          }
          catch (error) {
            degradedReason = error instanceof Error ? error.message : String(error);
            pi.logger?.warn?.('bounded controller reconciliation failed', {
              event,
              error: degradedReason,
            });
          }
        });
      }
    },
  };
}
