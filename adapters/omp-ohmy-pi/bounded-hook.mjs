import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DISPATCH_TOOLS = new Set(['task', 'eval', 'hub']);

function eventCwd(event, ctx) {
  return path.resolve(ctx?.cwd || event?.cwd || process.cwd());
}

function sessionId(event, ctx) {
  return event?.sessionId || event?.session_id || ctx?.sessionManager?.getSessionId?.();
}

function lifecycle(event) {
  return /(?:bounded(?:\.mjs)?|bounded-runtime(?:\.mjs)?)\s+(?:plan|approve|activate|complete|rollback|doctor|guard|reconcile)\b/i
    .test(JSON.stringify(event?.input ?? {}));
}

function block(reason) { return { block: true, reason }; }

function tokens(args) {
  const value = String(args ?? '').trim();
  return value ? value.split(/\s+/) : ['doctor'];
}

export function createBoundedHook({
  boundedBin = process.env.BOUNDED_BIN || 'bounded',
  env = process.env,
  run = async (args, options) => execFileAsync(boundedBin, args, {
    cwd: options.cwd, env, maxBuffer: 64 * 1024, encoding: 'utf8',
  }),
} = {}) {
  async function status(event, ctx) {
    const cwd = eventCwd(event, ctx);
    const result = await run(['status', '--cwd', cwd], { cwd });
    const output = typeof result === 'string' ? result : result.stdout;
    return JSON.parse(output);
  }

  async function reconcile(event, ctx) {
    try { await status(event, ctx); } catch (error) {
      if (event?.toolName && DISPATCH_TOOLS.has(event.toolName)) {
        return block(`bounded status unavailable: ${error instanceof Error ? error.message : 'request failed'}`);
      }
    }
    return undefined;
  }

  return (pi) => {
    pi.registerCommand('bounded', {
      description: 'Inspect and control bounded autonomy through the installed CLI.',
      async handler(args, ctx) {
        const result = await run(tokens(args), { cwd: eventCwd(undefined, ctx) });
        const output = typeof result === 'string' ? result : result.stdout;
        ctx.ui?.notify?.(String(output || '').trim(), 'info');
      },
    });
    pi.on('session_start', reconcile);
    pi.on('session_switch', reconcile);
    pi.on('session_branch', reconcile);
    pi.on('session_tree', reconcile);
    pi.on('tool_call', async (event, ctx) => {
      if (DISPATCH_TOOLS.has(event?.toolName)) return block('Direct coordination is outside bounded; use /bounded.');
      if (lifecycle(event)) return block('bounded lifecycle commands require the bounded terminal seam.');
      const result = await status(event, ctx);
      if (result?.active && result.sessionId && result.sessionId !== sessionId(event, ctx)) {
        return block('bounded runtime session does not match this OMP session');
      }
      return undefined;
    });
    pi.on('tool_result', async (event, ctx) => {
      try { await status(event, ctx); } catch {}
      return undefined;
    });
  };
}

export default createBoundedHook();
