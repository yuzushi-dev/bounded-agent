import fs from 'node:fs';
import path from 'node:path';

import { containsCredentialMaterial, validateContract } from './contract.mjs';

export const READ_TOOLS = new Set([
  'Read', 'read_file', 'Grep', 'grep', 'Glob', 'glob', 'LS', 'ls', 'view_image',
]);
const PATCH_TOOLS = new Set(['apply_patch', 'ApplyPatch']);
const FILE_WRITE_TOOLS = new Set(['Write', 'write_file', 'edit_file', 'Edit', 'file_edit', 'create_file']);
const SHELL_TOOLS = new Set(['Bash', 'bash', 'exec_command', 'shell']);
const DISPATCH_TOOLS = new Set(['Agent', 'task', 'eval', 'hub', 'SubagentStart', 'write_stdin']);
const CONTROL_COMMAND = /\bbounded(?:\.mjs)?\s+(?:approve|activate|complete|rollback)\b|\b--(?:approval|confirm)\b/i;
const CONTROL_API = /\b(?:createStateStore|recordHeartbeat|createApproval|activate|rollback|complete)\b/i;
const BOUNDED_SOURCE = /(?:bounded(?:[\\/]|\.mjs)|PLUGIN_(?:ROOT|DATA)|BOUNDED_STATE_ROOT)/i;
const SENSITIVE_SEGMENT = /^(?:\.ssh|\.gnupg|\.aws|\.npmrc|\.pypirc|\.netrc|\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]*(?:token|password|passwd|api[_-]?key|private[_-]?key)[^/]*)$/i;

function deny(reason) {
  return { allow: false, reason };
}

function inputObject(event) {
  return event?.tool_input ?? event?.toolInput ?? {};
}

function shellCommand(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return input.command ?? input.cmd ?? input.input;
}

function filePaths(input) {
  if (typeof input === 'string') return [input];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const values = [];
  for (const name of ['path', 'file_path', 'filePath', 'filename', 'target_file', 'targetFile', 'directory', 'dir']) {
    if (typeof input[name] === 'string') values.push(input[name]);
    else if (Array.isArray(input[name]) && input[name].every((value) => typeof value === 'string')) values.push(...input[name]);
    else if (input[name] !== undefined) return [];
  }
  return values;
}

function relativeCandidate(cwd, value) {
  if (typeof value !== 'string' || !value || value.includes('\u0000') || value.includes('\\')) return undefined;
  if (path.isAbsolute(value)) {
    if (value !== path.normalize(value)) return undefined;
    const relative = path.relative(cwd, value);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join('/');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

function safePath(cwd, candidate) {
  let rootExists = true;
  try { fs.lstatSync(cwd); } catch { rootExists = false; }
  if (!rootExists) return true;
  let current = cwd;
  const parts = candidate.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT' && index === parts.length - 1) return true;
      return false;
    }
    if (stat.isSymbolicLink()) return false;
    if (index < parts.length - 1 && !stat.isDirectory()) return false;
  }
  return true;
}

function sensitivePath(value) {
  return value.replaceAll('\\', '/').split('/').some((segment) => segment && SENSITIVE_SEGMENT.test(segment));
}

function scopeAllows(cwd, value, scopes) {
  const candidate = relativeCandidate(cwd, value);
  if (!candidate || !safePath(cwd, candidate)) return false;
  return scopes.some((scope) => {
    if (candidate === scope) return true;
    try {
      const scopePath = path.join(cwd, scope);
      const stat = fs.lstatSync(scopePath);
      return stat.isDirectory() && !stat.isSymbolicLink() && safePath(cwd, scope) && candidate.startsWith(`${scope}/`);
    } catch {
      return false;
    }
  });
}

function patchPaths(patch) {
  if (typeof patch !== 'string' || !patch.trim()) return [];
  const paths = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    const move = line.match(/^\*\*\* (?:Move|Copy) to: (.+)$/);
    if (match) paths.push(match[1].trim());
    if (move) paths.push(move[1].trim());
  }
  return paths;
}

function checkPatch(cwd, input, scopes) {
  const patch = typeof input === 'string' ? input : input?.command ?? input?.patch ?? input?.diff;
  const paths = patchPaths(patch);
  if (!paths.length) return deny('patch has no explicit file scope');
  return paths.every((value) => scopeAllows(cwd, value, scopes))
    ? { allow: true }
    : deny('patch escapes the bounded scope');
}

function checkFileWrite(cwd, input, scopes) {
  const targets = filePaths(input);
  return targets.length === 1 && scopeAllows(cwd, targets[0], scopes)
    ? { allow: true }
    : deny('file write is outside the bounded scope');
}

function checkGlob(cwd, input) {
  const pattern = input?.pattern;
  if (pattern === undefined) return deny('glob pattern is required');
  if (typeof pattern !== 'string' || !pattern || pattern.includes('\u0000') || pattern.includes('\\') || path.posix.isAbsolute(pattern)) {
    return deny('glob pattern is outside the bounded project');
  }
  const normalized = path.posix.normalize(pattern);
  if (normalized.startsWith('../') || normalized === '..' || sensitivePath(normalized)) return deny('glob pattern is sensitive or unsafe');
  const parts = normalized.split('/');
  const wildcardIndex = parts.findIndex((part) => /[*?[]/.test(part));
  const base = wildcardIndex < 0 ? normalized : parts.slice(0, wildcardIndex).join('/');
  if (base && !safePath(cwd, base)) return deny('glob base is sensitive or unsafe');
  return { allow: true };
}

function checkRead(cwd, tool, input) {
  if (tool === 'Glob' || tool === 'glob') return checkGlob(cwd, input);
  const targets = filePaths(input);
  if (['Read', 'read_file', 'Grep', 'grep', 'LS', 'ls', 'view_image'].includes(tool) && targets.length !== 1) {
    return deny('read path is required');
  }
  if (['Grep', 'grep'].includes(tool)) {
    const candidate = relativeCandidate(cwd, targets[0]);
    if (!candidate || !safePath(cwd, candidate)) return deny('grep path is sensitive or unsafe');
    try {
      const stat = fs.lstatSync(path.join(cwd, candidate));
      if (!stat.isFile() || stat.isSymbolicLink()) return deny('grep requires one explicit file');
    } catch {
      return deny('grep file is unavailable');
    }
  }
  for (const target of targets) {
    const candidate = relativeCandidate(cwd, target);
    if (!candidate) return deny('read path is outside the bounded project');
    if (sensitivePath(candidate) || !safePath(cwd, candidate)) return deny('read path is sensitive or unsafe');
  }
  return { allow: true };
}

function checkShell() {
  return deny('shell execution is disabled during a bounded run');
}

export function isReadTool(tool) {
  return READ_TOOLS.has(tool);
}

export function isBoundedControlCommand(input) {
  const command = shellCommand(input);
  return typeof command === 'string'
    && (CONTROL_COMMAND.test(command) || (CONTROL_API.test(command) && BOUNDED_SOURCE.test(command)));
}

export function artifactBytesForTool(tool, input) {
  if (PATCH_TOOLS.has(tool)) {
    const patch = shellCommand(input);
    return typeof patch === 'string' ? Buffer.byteLength(patch, 'utf8') : 0;
  }
  if (FILE_WRITE_TOOLS.has(tool)) {
    try { return Buffer.byteLength(JSON.stringify(input ?? {}), 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
  }
  return 0;
}

export function decidePreToolUse({ event, contract, state, now }) {
  if (!event || typeof event !== 'object' || typeof event.cwd !== 'string' || typeof event.tool_name !== 'string') {
    return deny('tool event is invalid');
  }
  try { validateContract(contract, { now }); } catch { return deny('bounded contract is invalid or expired'); }
  if (!state || state.status !== 'active' || state.cwd !== contract.cwd || state.contractDigest !== contract.digest
    || !Number.isSafeInteger(state.requestCount) || state.requestCount >= contract.budgets.maxRequests) {
    return deny(state?.status === 'expired' ? 'bounded run is expired' : 'bounded state is invalid or exhausted');
  }
  if (event.cwd !== contract.cwd) return deny('tool cwd is outside the bounded project');

  const tool = event.tool_name;
  const input = inputObject(event);
  if (containsCredentialMaterial(input)) return deny('credential material is prohibited');
  if (tool.startsWith('mcp__') || DISPATCH_TOOLS.has(tool)) return deny('dispatch and external tools are prohibited');
  if (READ_TOOLS.has(tool)) return checkRead(contract.cwd, tool, input);
  if (PATCH_TOOLS.has(tool)) return checkPatch(contract.cwd, input, contract.scope.paths);
  if (FILE_WRITE_TOOLS.has(tool)) return checkFileWrite(contract.cwd, input, contract.scope.paths);
  if (SHELL_TOOLS.has(tool)) return checkShell();
  return deny('tool is not allowed during a bounded run');
}
