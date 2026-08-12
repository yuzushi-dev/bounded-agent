import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const fixturePath = new URL('../fixtures/host-probes/omp-capability.json', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('records the exact local CLI capability decision without a model prompt', () => {
  assert.deepEqual(fixture, {
    schema: 'omp-host-integration-probe/v1',
    runtime: 'codex',
    cli: {
      name: 'codex',
      version: '0.147.0',
      commands: [
        {
          args: ['--version'],
          exitCode: 0,
          stdout: 'codex-cli 0.147.0\n',
          providerCalls: false,
        },
        {
          args: ['features', 'list'],
          exitCode: 0,
          features: {
            hooks: { stage: 'stable', enabled: true },
            plugin_hooks: { stage: 'removed', enabled: false },
            plugins: { stage: 'stable', enabled: true },
          },
          providerCalls: false,
        },
        {
          args: ['plugin', 'list', '--json', '--available'],
          exitCode: 0,
          stdout: '{\n  "installed": [],\n  "available": []\n}\n',
          providerCalls: false,
        },
      ],
    },
    preToolUseCoverage: {
      hostedTools: false,
      specialPaths: false,
      writeStdinFollowups: false,
    },
    decision: {
      universalPluginInterception: 'unsupported',
      reason: 'Codex exposes hooks, but plugin_hooks is removed and no universal PreToolUse interception contract is available.',
    },
  });
  assert.equal('prompt' in fixture, false);
  assert.equal('model' in fixture, false);
});

test('records harmless project plugin discovery in an isolated home', () => {
  const discovery = JSON.parse(fs.readFileSync(new URL('../fixtures/host-probes/plugin-list.json', import.meta.url), 'utf8'));
  assert.deepEqual(discovery, {
    command: ['codex', 'plugin', 'list', '--json', '--available'],
    home: 'temporary',
    exitCode: 0,
    stdout: '{\n  "installed": [],\n  "available": []\n}\n',
    providerCalls: false,
  });
});

test('declares the minimal Claude PreToolUse command hook contract', () => {
  const root = new URL('../fixtures/host-probes/claude-plugin/', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('.claude-plugin/plugin.json', root), 'utf8'));
  const hooks = JSON.parse(fs.readFileSync(new URL('hooks/hooks.json', root), 'utf8'));
  assert.deepEqual(manifest, {
    name: 'host-probe',
    version: '0.0.0',
    description: 'Deterministic PreToolUse host probe fixture.',
  });
  assert.deepEqual(hooks, {
    hooks: {
      PreToolUse: [{
        matcher: '.*',
        hooks: [{
          type: 'command',
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.mjs"',
        }],
      }],
    },
  });
});

test('invokes the Claude hook contract for built-in, subagent, and MCP events', () => {
  const root = new URL('../fixtures/host-probes/claude-plugin/', import.meta.url);
  const script = path.join(root.pathname, 'hooks/pre-tool-use.mjs');
  const cases = JSON.parse(fs.readFileSync(new URL('../fixtures/host-probes/claude-events.json', import.meta.url), 'utf8'));
  assert.deepEqual(cases, [
    {
      name: 'direct-built-in-allow',
      event: {
        hook_event_name: 'PreToolUse',
        session_id: 'session-direct',
        tool_name: 'Bash',
        tool_input: { command: 'printf safe' },
        tool_use_id: 'toolu-direct-allow',
      },
      output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'fixture policy allows this tool call' } },
    },
    {
      name: 'direct-built-in-deny',
      event: {
        hook_event_name: 'PreToolUse',
        session_id: 'session-direct',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf ./build' },
        tool_use_id: 'toolu-direct-deny',
      },
      output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'fixture policy denies destructive commands' } },
    },
    {
      name: 'subagent-origin-allow',
      event: {
        agent_id: 'agent-worker-1',
        agent_type: 'worker',
        hook_event_name: 'PreToolUse',
        parent_session_id: 'session-parent',
        session_id: 'session-subagent',
        tool_name: 'Bash',
        tool_input: { command: 'printf subagent-safe' },
        tool_use_id: 'toolu-subagent-allow',
      },
      output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'fixture policy allows this tool call' } },
    },
    {
      name: 'mcp-tool-deny',
      event: {
        hook_event_name: 'PreToolUse',
        session_id: 'session-mcp',
        tool_name: 'mcp__filesystem__write_file',
        tool_input: { content: 'fixture', path: 'artifact.txt' },
        tool_use_id: 'toolu-mcp-deny',
      },
      output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'fixture policy denies MCP writes' } },
    },
  ]);
  for (const fixture of cases) {
    const result = childProcess.spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root.pathname },
      input: `${JSON.stringify(fixture.event)}\n`, encoding: 'utf8',
    });
    assert.equal(result.status, 0, fixture.name);
    assert.equal(result.stderr, '', fixture.name);
    assert.deepEqual(JSON.parse(result.stdout), fixture.output, fixture.name);
  }
});
