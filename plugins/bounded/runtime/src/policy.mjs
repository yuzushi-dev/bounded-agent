const DISPATCH = /^(?:agent|task|delegate|mcp|computer|browser|web)/i;
const EXTERNAL = /(?:\bgit\s+(?:push|fetch|pull|clone)|\b(?:curl|wget|ssh|scp|nc)\b|https?:\/\/|\b(?:publish|deploy|send|purchase)\b)/i;

export function decideTool({ toolName, toolInput, cwd, status, sessionId }) {
  if (!status?.active) return { allow: true, reason: 'no active runtime run' };
  if (status.cwd !== cwd) return { allow: false, reason: 'runtime project binding failed' };
  if (sessionId && status.sessionId !== sessionId) return { allow: false, reason: 'runtime session binding failed' };
  if (DISPATCH.test(toolName || '')) return { allow: false, reason: 'dispatch is outside the runtime adapter seam' };
  const text = JSON.stringify(toolInput ?? {});
  if (EXTERNAL.test(text)) return { allow: false, reason: 'external effects are disabled' };
  if (/^(?:bash|sh|zsh|fish|powershell|cmd|exec)$/i.test(toolName || '')) return { allow: false, reason: 'arbitrary shell is outside runtime coverage' };
  return { allow: true, reason: 'runtime adapter accepted context' };
}
