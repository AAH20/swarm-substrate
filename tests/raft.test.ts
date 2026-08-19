import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RaftNode, DEFAULT_TIMERS, type NodeId } from '../src/raft.js';
import { SimulatedRaftNetwork } from '../src/raft-network.js';

function fastTimers() {
  // Faster than DEFAULT_TIMERS to keep tests quick, but keeping the same
  // ~10x heartbeat-to-election-timeout margin — going much tighter than
  // this (an earlier version used 40-80ms/15ms, a ~3-5x margin) reproduced
  // a genuine livelock on a slower JS engine: real ML-DSA-65 signing work in
  // the replicated-control-plane tests could delay a heartbeat past a too-
  // tight election timeout, triggering a spurious election that never
  // settled. See raft.ts's DEFAULT_TIMERS comment.
  return { electionTimeoutMinMs: 200, electionTimeoutMaxMs: 400, heartbeatIntervalMs: 20 };
}

function buildCluster(ids: readonly NodeId[], applied: Map<NodeId, { term: number; index: number; command: string }[]>) {
  const network = new SimulatedRaftNetwork<string>(2);
  const nodes = new Map<NodeId, RaftNode<string>>();
  for (const id of ids) {
    const peers = ids.filter((n) => n !== id);
    const log: { term: number; index: number; command: string }[] = [];
    applied.set(id, log);
    const node = new RaftNode<string>(
      id,
      peers,
      network.transportFor(id),
      (command, index) => log.push({ term: node.getTerm(), index, command }),
      fastTimers(),
    );
    nodes.set(id, node);
    network.register(id, node);
  }
  return { network, nodes };
}

async function waitForLeader(
  nodes: Map<NodeId, RaftNode<string>>,
  network: SimulatedRaftNetwork<string>,
  timeoutMs = 2000,
): Promise<RaftNode<string>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const [id, node] of nodes) {
      // A killed node keeps its own timers running and can go on
      // self-reporting 'leader' even though it's unreachable — a real
      // caller only reaches nodes through the network, so this must too.
      if (node.getRole() === 'leader' && network.isAlive(id)) return node;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no leader elected within timeout');
}

test('a cluster elects exactly one leader', async () => {
  const applied = new Map<NodeId, unknown[]>();
  const { network, nodes } = buildCluster(['a', 'b', 'c'], applied as never);
  for (const node of nodes.values()) node.start();

  const leader = await waitForLeader(nodes, network);
  const leaders = [...nodes.values()].filter((n) => n.getRole() === 'leader');
  assert.equal(leaders.length, 1);
  assert.equal(leader.getTerm() >= 1, true);

  for (const node of nodes.values()) node.stop();
});

test('a proposed command replicates to a majority and applies on every replica', async () => {
  const applied = new Map<NodeId, { term: number; index: number; command: string }[]>();
  const { network, nodes } = buildCluster(['a', 'b', 'c'], applied);
  for (const node of nodes.values()) node.start();

  const leader = await waitForLeader(nodes, network);
  await leader.propose('hello-swarm');

  // Give followers one more heartbeat round to learn the new commitIndex.
  await new Promise((r) => setTimeout(r, 60));

  for (const [id, log] of applied) {
    assert.equal(log.length, 1, `node ${id} should have applied exactly one command`);
    assert.equal(log[0]!.command, 'hello-swarm');
  }

  for (const node of nodes.values()) node.stop();
});

test('killing the leader triggers re-election and the cluster keeps accepting writes', async () => {
  const applied = new Map<NodeId, { term: number; index: number; command: string }[]>();
  const { network, nodes } = buildCluster(['a', 'b', 'c'], applied);
  for (const node of nodes.values()) node.start();

  const firstLeader = await waitForLeader(nodes, network);
  await firstLeader.propose('before-crash');
  await new Promise((r) => setTimeout(r, 60));

  // A real crash stops the process, not just its reachability — killing
  // only at the network layer would leave this node's own timers running,
  // still self-reporting 'leader' forever.
  network.kill(firstLeader.id);
  firstLeader.stop();

  const secondLeader = await waitForLeader(nodes, network, 3000);
  assert.notEqual(secondLeader.id, firstLeader.id);

  await secondLeader.propose('after-crash');
  await new Promise((r) => setTimeout(r, 60));

  const survivingLog = applied.get(secondLeader.id)!;
  assert.equal(survivingLog.length, 2, 'the entry from before the crash must not be lost');
  assert.equal(survivingLog[0]!.command, 'before-crash');
  assert.equal(survivingLog[1]!.command, 'after-crash');

  for (const node of nodes.values()) node.stop();
});

test('propose() rejects on a non-leader node', async () => {
  const applied = new Map<NodeId, unknown[]>();
  const { network, nodes } = buildCluster(['a', 'b', 'c'], applied as never);
  for (const node of nodes.values()) node.start();

  const leader = await waitForLeader(nodes, network);
  const follower = [...nodes.values()].find((n) => n.id !== leader.id)!;

  await assert.rejects(() => follower.propose('should-fail'));

  for (const node of nodes.values()) node.stop();
});
