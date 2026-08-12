const VERSION = '0.147.0';

function findUsage(value) {
  if (!value || typeof value !== 'object') return null;
  if (Number.isFinite(value.input_tokens) && Number.isFinite(value.output_tokens)) {
    return { inputTokens: value.input_tokens, outputTokens: value.output_tokens,
      totalTokens: value.total_tokens ?? value.input_tokens + value.output_tokens };
  }
  for (const child of Object.values(value)) {
    const usage = findUsage(child);
    if (usage) return usage;
  }
  return null;
}

function extractUsage({ stdout }) {
  const lines = stdout.trim().split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const usage = findUsage(JSON.parse(line));
      if (usage) return usage;
    } catch {}
  }
  return null;
}

export function buildCodexCommand({ prompt, outputSchema, lastMessagePath }) {
  if (typeof prompt !== 'string' || !prompt || typeof outputSchema !== 'string' || !outputSchema
    || typeof lastMessagePath !== 'string' || !lastMessagePath) {
    throw new Error('codex prompt and structured output paths are required');
  }
  return {
    command: 'codex',
    args: ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', '--output-schema', outputSchema,
      '--output-last-message', lastMessagePath, prompt],
    resultFile: lastMessagePath.split('/').at(-1),
    extractUsage,
  };
}

export function buildCodexExecutorCommand({ prompt, outputSchema, lastMessagePath }) {
  if (typeof prompt !== 'string' || !prompt || typeof outputSchema !== 'string' || !outputSchema
    || typeof lastMessagePath !== 'string' || !lastMessagePath) throw new Error('codex executor structured output is required');
  return {
    command: 'codex',
    args: ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', '/work', '--json',
      '--output-schema', outputSchema, '--output-last-message', lastMessagePath, prompt],
    resultFile: lastMessagePath.split('/').at(-1),
    extractUsage,
  };
}

export function createCodexAdapter({ command = 'codex' } = {}) {
  return {
    family: 'openai-codex',
    version: VERSION,
    command,
    buildExecutorCommand: ({ prompt, outputSchema, lastMessagePath }) => ({
      ...buildCodexExecutorCommand({ prompt, outputSchema, lastMessagePath }), command,
    }),
    buildCommand: ({ prompt, outputSchema, lastMessagePath }) => ({
      ...buildCodexCommand({ prompt, outputSchema, lastMessagePath }), command,
    }),
  };
}
