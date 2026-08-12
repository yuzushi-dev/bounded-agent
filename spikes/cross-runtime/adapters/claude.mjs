const VERSION = '2.1.227';

function normalizedUsage(wrapper) {
  const usage = wrapper?.usage;
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return null;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens };
}

function parseStructured(stdout) {
  const wrapper = JSON.parse(stdout);
  if (wrapper.structured_output && typeof wrapper.structured_output === 'object') return wrapper.structured_output;
  if (typeof wrapper.result === 'string') return JSON.parse(wrapper.result);
  throw new Error('Claude structured result is missing');
}

export function buildClaudeCommand({ prompt, schema, model }) {
  if (typeof prompt !== 'string' || !prompt || !schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('claude prompt and JSON schema are required');
  }
  return {
    command: 'claude',
    args: [...(model ? ['--model', model] : []), '--print', '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
      '--tools', 'Read,Grep,Glob', '--permission-mode', 'plan', '--strict-mcp-config',
      '--output-format', 'json', '--json-schema', JSON.stringify(schema), prompt],
    parseResult: ({ stdout }) => parseStructured(stdout),
    extractUsage: ({ stdout }) => {
      try { return normalizedUsage(JSON.parse(stdout)); } catch { return null; }
    },
  };
}

export function buildClaudeExecutorCommand({ prompt, schema, model }) {
  if (typeof prompt !== 'string' || !prompt || !schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('claude executor structured output is required');
  }
  return {
    command: 'claude',
    args: [...(model ? ['--model', model] : []), '--print', '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
      '--tools', '', '--permission-mode', 'plan', '--strict-mcp-config', '--output-format', 'json',
      '--json-schema', JSON.stringify(schema), prompt],
    parseResult: ({ stdout }) => parseStructured(stdout),
    extractUsage: ({ stdout }) => {
      try { return normalizedUsage(JSON.parse(stdout)); } catch { return null; }
    },
  };
}

export function createClaudeAdapter({ command = 'claude', model } = {}) {
  return {
    family: 'anthropic',
    version: VERSION,
    command,
    buildExecutorCommand: ({ prompt, schema }) => ({ ...buildClaudeExecutorCommand({ prompt, schema, model }), command }),
    buildCommand: ({ prompt, schema }) => ({ ...buildClaudeCommand({ prompt, schema, model }), command }),
  };
}
