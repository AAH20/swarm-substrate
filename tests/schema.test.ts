import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SwarmEnvelope } from '../src/schema.js';

test('SwarmEnvelope shape is usable as a plain object literal', () => {
  const envelope: SwarmEnvelope = { nodeId: 'n1', round: 1, kind: 'proposal', value: 'action-A', payload: { x: 1 } };
  assert.equal(envelope.nodeId, 'n1');
  assert.equal(envelope.kind, 'proposal');
});
