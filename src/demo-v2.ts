#!/usr/bin/env node
/**
 * v0.2 demonstration: the two scaling properties `npm run demo` doesn't
 * cover — hierarchical consensus tolerating an entire compromised
 * committee, and the replicated control plane surviving a leader crash
 * with no data loss. `npm run demo:v2` after building.
 */
import { partitionIntoCommittees, tallyHierarchical, type CommitteeVotes } from './committee-consensus.js';
import { createControlPlaneCluster } from './replicated-control-plane.js';
import { createNode, attestEnvelope } from './provenance.js';
import type { SwarmEnvelope } from './schema.js';

interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: CheckResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}`);
  if (!passed) console.log(`    ${detail}`);
}

// --- Part 1: hierarchical consensus tolerates a fully compromised committee ---
console.log('Part 1 — hierarchical consensus (4 committees x 4 nodes, one committee fully compromised)');

function honestCommittee(id: string): CommitteeVotes {
  return {
    committeeId: id,
    totalMembers: 4,
    votes: ['m1', 'm2', 'm3', 'm4'].map((m) => ({ nodeId: `${id}-${m}`, value: 'action-A' })),
  };
}
const compromisedCommittee: CommitteeVotes = {
  committeeId: 'D',
  totalMembers: 4,
  votes: [
    { nodeId: 'D-m1', value: 'action-A' },
    { nodeId: 'D-m2', value: 'action-A' },
    { nodeId: 'D-m3', value: 'action-B' },
    { nodeId: 'D-m4', value: 'action-B' },
  ],
};

const partitionCheck = partitionIntoCommittees(Array.from({ length: 16 }, (_, i) => `n${i}`), 4);
record('16 nodes partition into 4 committees of 4', partitionCheck.length === 4, `got ${partitionCheck.length} committees`);

const hierarchical = tallyHierarchical([honestCommittee('A'), honestCommittee('B'), honestCommittee('C'), compromisedCommittee]);
const committeeD = hierarchical.committeeOutcomes.find((o) => o.committeeId === 'D');
record('committee D (2-2 split) fails to reach local quorum', committeeD?.result.decided === false, JSON.stringify(committeeD));
record(
  'global decision still reached on the 3 honest committees alone',
  hierarchical.decided === true && hierarchical.value === 'action-A',
  JSON.stringify({ decided: hierarchical.decided, value: hierarchical.value, metaQuorum: hierarchical.metaQuorum }),
);

// --- Part 2: replicated control plane survives a leader crash ---
console.log('\nPart 2 — replicated ledger + kill-switch survive killing the leader replica');

async function waitForLeader(cluster: ReturnType<typeof createControlPlaneCluster>, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const leader = cluster.currentLeader();
    if (leader) return leader;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no leader elected within timeout');
}

const cluster = createControlPlaneCluster(['r1', 'r2', 'r3'], 2);
cluster.start();

const leader1 = await waitForLeader(cluster);
const agent = createNode('agent-1');
const envelope: SwarmEnvelope = { nodeId: 'agent-1', round: 1, kind: 'proposal', value: 'action-A', payload: {} };
await attestEnvelope({ store: leader1, node: agent, envelope, integrityViolation: undefined });
await leader1.recordViolation('agent-1');
await leader1.recordViolation('agent-1');
// A follower's own locally-applied state (what isQuarantined/list read)
// can lag the leader's commit by up to ~2 heartbeat rounds: the entry
// arrives on one heartbeat, but a follower only learns the updated
// leaderCommit — and so only applies it — on the *next* one. This waits
// long enough relative to DEFAULT_TIMERS' 100ms heartbeat for that to
// have happened before reading state below.
await new Promise((r) => setTimeout(r, 400));

let leaderId: string | undefined;
for (const [id, replica] of cluster.replicas) if (replica === leader1) leaderId = id;
record('a leader was elected before the crash', leaderId !== undefined, `leaderId=${leaderId}`);

cluster.kill(leaderId!);
const leader2 = await waitForLeader(cluster);
record('a different replica takes over after the crash', leader2 !== leader1, 'leadership must move, not vanish');

const survived = await leader2.list('agent-1');
record('the pre-crash ledger entry survived on the new leader', survived.length === 1, `entries=${survived.length}`);
record('the pre-crash kill-switch quarantine survived on the new leader', leader2.isQuarantined('agent-1'), '');

const agent2 = createNode('agent-2');
const envelope2: SwarmEnvelope = { nodeId: 'agent-2', round: 1, kind: 'proposal', value: 'action-B', payload: {} };
await attestEnvelope({ store: leader2, node: agent2, envelope: envelope2, integrityViolation: undefined });
// A follower's own locally-applied state (what isQuarantined/list read)
// can lag the leader's commit by up to ~2 heartbeat rounds: the entry
// arrives on one heartbeat, but a follower only learns the updated
// leaderCommit — and so only applies it — on the *next* one. This waits
// long enough relative to DEFAULT_TIMERS' 100ms heartbeat for that to
// have happened before reading state below.
await new Promise((r) => setTimeout(r, 400));
const postCrashEntries = await leader2.list('agent-2');
record('the cluster keeps accepting new writes after losing one replica', postCrashEntries.length === 1, `entries=${postCrashEntries.length}`);

cluster.stop();

const allPassed = checks.every((c) => c.passed);
console.log('\n' + (allPassed ? 'PASSED — every guarantee held.' : 'FAILED — see above.'));
process.exitCode = allPassed ? 0 : 1;
