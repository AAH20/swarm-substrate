import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNode, InMemoryLedgerStore, attestEnvelope, verifyNodeLedger } from '../src/provenance.js';
import type { SwarmEnvelope } from '../src/schema.js';

test('attesting a clean envelope produces a verifiable ledger entry', async () => {
  const node = createNode('n1');
  const store = new InMemoryLedgerStore();
  const envelope: SwarmEnvelope = { nodeId: 'n1', round: 1, kind: 'proposal', value: 'action-A', payload: { x: 1 } };

  const entry = await attestEnvelope({ store, node, envelope, integrityViolation: undefined });
  assert.equal(entry.actionType, 'proposal');

  const result = await verifyNodeLedger(store, 'n1');
  assert.equal(result.valid, true);
  assert.equal(result.totalEntries, 1);
});

test('a rejected envelope is still attested, with actionType marked "rejected"', async () => {
  const node = createNode('n1');
  const store = new InMemoryLedgerStore();
  const envelope: SwarmEnvelope = { nodeId: 'n1', round: 1, kind: 'proposal', value: 'action-A', payload: { x: 1 } };

  const entry = await attestEnvelope({ store, node, envelope, integrityViolation: 'forbidden key "__proto__"' });
  assert.equal(entry.actionType, 'proposal:rejected');
  assert.match(entry.summary, /rejected/);

  const result = await verifyNodeLedger(store, 'n1');
  assert.equal(result.valid, true, 'a rejected action is still a validly-chained, validly-signed ledger entry');
});

test('tampering with an attested entry breaks independent verification', async () => {
  const node = createNode('n1');
  const store = new InMemoryLedgerStore();
  const envelope: SwarmEnvelope = { nodeId: 'n1', round: 1, kind: 'vote', value: 'action-A', payload: {} };
  await attestEnvelope({ store, node, envelope, integrityViolation: undefined });

  const entries = await store.list('n1');
  (entries[0] as { summary: string }).summary = 'tampered';
  // Note: store.list() returns a copy, so mutate the store's internal copy via append semantics isn't
  // possible directly — this test exercises verifyChain's own tamper-detection on a hand-tampered copy.
  const { verifyChain } = await import('pqattest');
  const result = verifyChain(entries);
  assert.equal(result.valid, false);
});
