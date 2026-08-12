# Cross-runtime spike

This spike tests two host-supervised lanes without changing the OMP enforcement claim:

```text
Codex executor  -> verification envelope -> Claude verifier
Claude executor -> verification envelope -> Codex verifier
```

Local versions were Codex CLI `0.147.0` and Claude Code `2.1.227`. Both were authenticated through their own read-only credential file. The controller never copied a credential into the repository, an envelope, output, or the opposite-provider process.

## Boundary

The host chooses the opposite verifier family. Executors emit one structured artifact proposal; the host validates path, count, bytes, and scope before materializing it. Verifiers run under `prlimit` and `bubblewrap` with audited roots read-only, private scratch writable, no delivery mount, a combined output cap, a 120-second deadline, process-group termination, and cleanup in `finally`.

The only evidence schema is `omp-verification-envelope/v1`. It binds the run and contract digests, base and source tree digests, write scope, resulting diff, artifact set and digest, executed checks, executor and verifier families, timestamps, nonce, and its own digest. The verifier returns exactly:

```json
{
  "verdict": "CLEAN",
  "findings": [],
  "contractDigest": "sha256:...",
  "artifactDigest": "sha256:...",
  "verifierFamily": "anthropic"
}
```

Tests reject same-family routing, missing or executor-selected verifiers, altered or stale envelopes, contract/scope/source drift, symlinks, verifier writes, delivery visibility, opposite credentials, output overflow, timeout, spawn/parse failure, malformed verdicts, and `CLEAN` with findings. Fake clean and defect fixtures cover both directions; subprocess tests exercise real `bubblewrap` read-only mounts and cleanup.

## Host capabilities

| Capability | Claude Code 2.1.227 | Codex CLI 0.147.0 |
|---|---|---|
| Structured output | `--output-format json --json-schema` | `codex exec --json --output-schema --output-last-message` |
| Non-persistent run | `--no-session-persistence` | `--ephemeral` |
| Plugin discovery | `--plugin-dir`; isolated fixture validates | Marketplace/plugin CLI present |
| Pre-tool interception | `PreToolUse` covers built-ins, subagent-origin calls, and MCP tool calls | Not universal: hosted/special paths and `write_stdin` follow-ups are outside complete coverage |
| Standalone enforcement | Possible only with exact hook policy plus the external controller | Unsupported; external controller is mandatory |

Claude `SubagentStart` is observational, so subagent creation must also be restricted through tool permissions. Codex plugin-only enforcement is not claimed.

Credential environment names recorded by the capability probe were:

- Codex: `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`;
- Claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, the documented Bedrock/Vertex/Foundry selectors, and their provider credential variables.

The live machine used file-backed first-party authentication instead. Only `~/.codex/auth.json` or `~/.claude/.credentials.json` was mounted into its matching process.

## Live result and decision

The machine-readable summary is [`fixtures/live-results.json`](fixtures/live-results.json).

- `Codex -> Claude`: the structured Codex artifact crossed host scope validation. Claude correctly found the injected defect with a bound `CHANGES_REQUIRED` result, but the clean verifier run hit the enforced 120-second timeout. **NO-GO**.
- `Claude -> Codex`: the structured Claude artifact crossed host scope validation. On both clean and defect inputs, Codex returned a contract digest different from the immutable envelope; the host rejected it. **NO-GO**.

Containment, family credential separation, envelope tamper detection, timeout termination, and crash cleanup passed locally. A live end-to-end clean verdict did not pass in either direction. Token and latency comparison is therefore incomplete by design rather than inferred from failed runs. The successful Claude defect verification took 22,597 ms and reported 1,801 tokens.

Task 9 has no real cross-runtime consumer, so no MCP server is created. Task 10 requires a `GO` lane; therefore no Codex or Claude compatibility shell is packaged. OMP remains the only enforcement build. Publish and marketplace actions remain human-gated.

## Sources

- [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [hooks](https://learn.chatgpt.com/docs/hooks), [MCP](https://learn.chatgpt.com/docs/extend/mcp), [plugins](https://learn.chatgpt.com/docs/codex/build-plugins)
- [Claude hooks](https://code.claude.com/docs/en/hooks), [plugins](https://code.claude.com/docs/en/plugins), [subagents](https://code.claude.com/docs/en/sub-agents), [permissions](https://code.claude.com/docs/en/permissions), [CLI](https://code.claude.com/docs/en/cli-reference), [MCP](https://code.claude.com/docs/en/mcp)
