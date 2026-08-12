import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
const command = event.tool_input?.command;
const mcpWrite = /^mcp__.*__(?:write|edit|delete|apply)/i.test(event.tool_name || '');
const destructive = typeof command === 'string' && /(?:^|\s)rm\s+-rf(?:\s|$)/.test(command);
const permissionDecision = destructive || mcpWrite ? 'deny' : 'allow';
const permissionDecisionReason = destructive
  ? 'fixture policy denies destructive commands'
  : mcpWrite
    ? 'fixture policy denies MCP writes'
    : 'fixture policy allows this tool call';

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision,
    permissionDecisionReason,
  },
})}\n`);
