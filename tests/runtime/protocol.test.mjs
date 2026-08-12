import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  validateRequest,
} from '../../plugins/bounded/runtime/src/protocol.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;

test('encodes and decodes one versioned local JSONL message', () => {
  const line = encodeMessage({
    version: PROTOCOL_VERSION,
    id: 'request-1',
    clientId: 'codex-client-1',
    method: 'status',
    params: { runId: `run_${'a'.repeat(24)}` },
  });

  assert.equal(line.endsWith('\n'), true);
  assert.deepEqual(decodeMessage(line), {
    version: PROTOCOL_VERSION,
    id: 'request-1',
    clientId: 'codex-client-1',
    method: 'status',
    params: { runId: `run_${'a'.repeat(24)}` },
  });
});

test('rejects malformed, wrong-version, and multi-line protocol input', () => {
  assert.throws(() => decodeMessage('{not-json}\n'), /protocol|json/i);
  assert.throws(() => decodeMessage(`${JSON.stringify({ version: 99, id: 'x', method: 'status', params: {} })}\n`), /version/i);
  assert.throws(() => decodeMessage(`${JSON.stringify({ version: PROTOCOL_VERSION, id: 'x', clientId: 'client-1', method: 'status', params: { value: 'x\ny' } })}\n`), /line|control|protocol/i);
  assert.throws(() => decodeMessage(''), /message|line|empty/i);
});

test('requires identity, digest, lease, and counter bindings for mutations', () => {
  assert.throws(() => validateRequest({
    version: PROTOCOL_VERSION,
    id: 'request-1',
    clientId: 'codex-client-1',
    method: 'activate',
    params: { runId: `run_${'a'.repeat(24)}` },
  }), /contract|digest|session|proof/i);

  const request = {
    version: PROTOCOL_VERSION,
    id: 'request-2',
    clientId: 'codex-client-1',
    method: 'rollback',
    params: {
      runId: `run_${'a'.repeat(24)}`,
      contractDigest: DIGEST,
      sessionId: 'session-1',
      leaseId: 'lease-1',
      counter: 4,
      reason: 'operator requested rollback',
    },
  };
  assert.deepEqual(validateRequest(request), request);
});
