import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIntegrity } from '../src/integrity.js';
import type { SwarmEnvelope } from '../src/schema.js';

function env(payload: unknown): SwarmEnvelope {
  return { nodeId: 'n1', round: 1, kind: 'proposal', value: 'action-A', payload };
}

test('clean payload passes', () => {
  assert.equal(checkIntegrity(env({ note: 'fine' })), null);
});

test('catches a JSON.parse-derived __proto__ key (real prototype-pollution shape)', () => {
  const payload = JSON.parse('{"note":"looks fine","__proto__":{"polluted":true}}');
  const violation = checkIntegrity(env(payload));
  assert.notEqual(violation, null);
  assert.match(violation!.reason, /forbidden key/);
});

test('catches a nested forbidden key', () => {
  const payload = JSON.parse('{"outer":{"constructor":{"x":1}}}');
  const violation = checkIntegrity(env(payload));
  assert.notEqual(violation, null);
  assert.match(violation!.reason, /forbidden key "constructor"/);
});

test('does NOT flag an object-literal __proto__ (no own property to find)', () => {
  // Documents the actual JS semantics this scanner relies on: an object
  // literal's __proto__ key sets the prototype slot, not an own property,
  // so Object.keys() never sees it. This scanner only ever protects against
  // the JSON.parse arrival path, which is the one that matters for wire
  // payloads — this test exists so that boundary doesn't get "fixed" by
  // accident into something that silently stops working.
  const payload = { note: 'fine', __proto__: { polluted: true } };
  assert.equal(checkIntegrity(env(payload)), null);
});

test('catches an oversized string field', () => {
  const violation = checkIntegrity(env({ blob: 'x'.repeat(5000) }));
  assert.notEqual(violation, null);
  assert.match(violation!.reason, /oversized string/);
});

test('catches a non-JSON-serializable payload', () => {
  const payload: Record<string, unknown> = { fn: () => 1 };
  payload.self = payload; // circular reference
  const violation = checkIntegrity(env(payload));
  assert.notEqual(violation, null);
  assert.match(violation!.reason, /not JSON-serializable/);
});
