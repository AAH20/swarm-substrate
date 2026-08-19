import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlaneCluster } from '../src/replicated-control-plane.js';
import { createNode } from '../src/provenance.js';
import { attestEnvelope } from '../src/provenance.js';
import type { SwarmEnvelope } from '../src/schema.js';

function fastTimers() {
  // See raft.test.ts: a ~3-5x heartbeat-to-election-timeout margin
  // reproduced a genuine livelock here specifically, because this test does
  // real ML-DSA-65 signing (via attestEnvelope) that competes with Raft's
  // own timer callbacks for the JS thread. ~10x is the margin that held up.
  return { electionTimeoutMinMs: 200, electionTimeoutMaxMs: 400, heartbeatIntervalMs: 20 };
}

async function waitForLeader(cluster: ReturnType<typeof createControlPlaneCluster>, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const leader = cluster.currentLeader();
    if (leader) return leader;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no leader elected within timeout');
}

test('the ledger and kill-switch state survive killing the leader replica', async () => {
  const cluster = createControlPlaneCluster(['r1', 'r2', 'r3'], 2, fastTimers());
  cluster.start();

  const leader1 = await waitForLeader(cluster);
  const agentNode = createNode('agent-1');
  const envelope: SwarmEnvelope = { nodeId: 'agent-1', round: 1, kind: 'proposal', value: 'action-A', payload: { x: 1 } };

  // Write through the current leader — attest an action, and record two
  // kill-switch violations, replicated to a majority before either resolves.
  await attestEnvelope({ store: leader1, node: agentNode, envelope, integrityViolation: undefined });
  await leader1.recordViolation('agent-1');
  const secondViolation = await leader1.recordViolation('agent-1');
  assert.equal(secondViolation.tripped, true);
  assert.equal(leader1.isQuarantined('agent-1'), true);

  await new Promise((r) => setTimeout(r, 60)); // let followers catch up on commitIndex

  // Find this leader's raft id and kill it — simulating a crash of whichever
  // replica happened to be leading.
  let leaderId: string | undefined;
  for (const [id, replica] of cluster.replicas) {
    if (replica === leader1) leaderId = id;
  }
  assert.ok(leaderId, 'must be able to identify the leader replica');
  cluster.kill(leaderId!);

  const leader2 = await waitForLeader(cluster, 3000);
  assert.notEqual(leader2, leader1, 'a different replica must take over leadership');

  // State from before the crash must have survived on the new leader.
  const survivedEntries = await leader2.list('agent-1');
  assert.equal(survivedEntries.length, 1);
  assert.equal(leader2.isQuarantined('agent-1'), true, 'kill-switch state must survive the leader crash too');

  // The cluster must remain available: new writes still succeed through the new leader.
  const envelope2: SwarmEnvelope = { nodeId: 'agent-2', round: 1, kind: 'proposal', value: 'action-B', payload: {} };
  const agentNode2 = createNode('agent-2');
  await attestEnvelope({ store: leader2, node: agentNode2, envelope: envelope2, integrityViolation: undefined });
  await new Promise((r) => setTimeout(r, 60));
  const newEntries = await leader2.list('agent-2');
  assert.equal(newEntries.length, 1, 'the cluster must keep accepting writes after losing one replica');

  cluster.stop();
});
