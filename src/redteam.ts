/**
 * Independent verification: assembles a small swarm with one byzantine
 * node and drives it through a scripted adversarial scenario, asserting
 * the guarantees the rest of the stack claims to provide. This is what
 * makes the composition a proof rather than a diagram — the checks below
 * run against the real output of `runRound`, not against what the other
 * modules are supposed to do.
 *
 * Scenario (n=4, quorum=3, kill-switch threshold=2):
 *   Round 1 — n4 submits a poisoned proposal (prototype-pollution payload).
 *   Round 2 — n4 casts a dissenting vote; honest majority still decides.
 *   Round 3 — n4's second poisoned payload crosses the kill-switch threshold.
 *   Round 4 — n4 is quarantined; the swarm proceeds without it.
 */
import { createNode, InMemoryLedgerStore, verifyNodeLedger, type SwarmNode } from './provenance.js';
import { KillSwitch } from './killswitch.js';
import { runRound, type SwarmConfig } from './swarm.js';
import type { SwarmEnvelope } from './schema.js';

export interface ScenarioCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface RedTeamReport {
  readonly passed: boolean;
  readonly checks: readonly ScenarioCheck[];
}

const HONEST_VALUE = 'action-A';
const BYZANTINE_VALUE = 'action-B';
// Built via JSON.parse, not an object literal: `{ __proto__: {...} }` as a
// literal sets the object's prototype slot rather than creating an own
// property, so Object.keys() would never see it — that's not how a real
// prototype-pollution payload arrives. JSON.parse doesn't special-case
// __proto__, so this genuinely reproduces an own enumerable "__proto__" key,
// the way untrusted JSON actually would.
const poisonedPayload: unknown = JSON.parse('{"note":"looks fine","__proto__":{"polluted":true}}');
const cleanPayload = { note: 'ordinary tool call' };

export async function runAdversarialScenario(): Promise<RedTeamReport> {
  const nodes: SwarmNode[] = [createNode('n1'), createNode('n2'), createNode('n3'), createNode('n4-byzantine')];
  const [n1, n2, n3, n4] = nodes as [SwarmNode, SwarmNode, SwarmNode, SwarmNode];
  const store = new InMemoryLedgerStore();
  const killSwitch = new KillSwitch(2);
  const config: SwarmConfig = { nodes, store, killSwitch };
  const checks: ScenarioCheck[] = [];

  // Round 1: n4 proposes a poisoned payload alongside three clean proposals.
  const round1 = await runRound(config, 1, [
    envelope(n1.nodeId, 1, 'proposal', HONEST_VALUE, cleanPayload),
    envelope(n2.nodeId, 1, 'proposal', HONEST_VALUE, cleanPayload),
    envelope(n3.nodeId, 1, 'proposal', HONEST_VALUE, cleanPayload),
    envelope(n4.nodeId, 1, 'proposal', HONEST_VALUE, poisonedPayload),
  ]);
  const n4Round1 = round1.outcomes.find((o) => o.nodeId === n4.nodeId);
  checks.push({
    name: 'integrity layer catches the poisoned proposal',
    passed: n4Round1?.integrityViolation !== undefined,
    detail: `n4 outcome: ${JSON.stringify(n4Round1)}`,
  });
  checks.push({
    name: 'rejected attempt is still attested, not silently dropped',
    passed: n4Round1?.attestation !== undefined,
    detail: 'a caught attack should leave evidence it was attempted',
  });

  // Round 2: n4 dissents with a clean vote; honest majority still decides.
  const round2 = await runRound(config, 2, [
    envelope(n1.nodeId, 2, 'vote', HONEST_VALUE, cleanPayload),
    envelope(n2.nodeId, 2, 'vote', HONEST_VALUE, cleanPayload),
    envelope(n3.nodeId, 2, 'vote', HONEST_VALUE, cleanPayload),
    envelope(n4.nodeId, 2, 'vote', BYZANTINE_VALUE, cleanPayload),
  ]);
  checks.push({
    name: 'consensus reaches the honest value despite byzantine dissent',
    passed: round2.consensus?.decided === true && round2.consensus.value === HONEST_VALUE,
    detail: `consensus: ${JSON.stringify(round2.consensus)}`,
  });

  // Round 3: n4's second poisoned payload should cross the kill-switch threshold.
  const round3 = await runRound(config, 3, [
    envelope(n1.nodeId, 3, 'vote', HONEST_VALUE, cleanPayload),
    envelope(n2.nodeId, 3, 'vote', HONEST_VALUE, cleanPayload),
    envelope(n3.nodeId, 3, 'vote', HONEST_VALUE, cleanPayload),
    envelope(n4.nodeId, 3, 'vote', HONEST_VALUE, poisonedPayload),
  ]);
  const n4Round3 = round3.outcomes.find((o) => o.nodeId === n4.nodeId);
  checks.push({
    name: 'kill-switch trips exactly when the violation threshold is crossed',
    passed: n4Round3?.violationResult?.tripped === true && killSwitch.isQuarantined(n4.nodeId),
    detail: `n4 violation result: ${JSON.stringify(n4Round3?.violationResult)}`,
  });
  checks.push({
    name: 'consensus still holds during the round the trip happens',
    passed: round3.consensus?.decided === true && round3.consensus.value === HONEST_VALUE,
    detail: `consensus: ${JSON.stringify(round3.consensus)}`,
  });

  // Round 4: n4 is quarantined; it must be excluded before integrity even runs.
  const round4 = await runRound(config, 4, [
    envelope(n1.nodeId, 4, 'vote', HONEST_VALUE, cleanPayload),
    envelope(n2.nodeId, 4, 'vote', HONEST_VALUE, cleanPayload),
    envelope(n3.nodeId, 4, 'vote', HONEST_VALUE, cleanPayload),
    envelope(n4.nodeId, 4, 'vote', HONEST_VALUE, cleanPayload),
  ]);
  const n4Round4 = round4.outcomes.find((o) => o.nodeId === n4.nodeId);
  checks.push({
    name: 'quarantine holds in later rounds — n4 excluded before integrity runs',
    passed: n4Round4?.excludedAsQuarantined === true && n4Round4.integrityViolation === undefined,
    detail: `n4 outcome: ${JSON.stringify(n4Round4)}`,
  });
  checks.push({
    name: 'swarm reaches consensus on the remaining honest quorum alone',
    passed: round4.consensus?.decided === true && round4.consensus.value === HONEST_VALUE,
    detail: `consensus: ${JSON.stringify(round4.consensus)}`,
  });

  // Independent ledger re-verification: no trust in the nodes that produced it required.
  for (const node of nodes) {
    const result = await verifyNodeLedger(store, node.nodeId);
    checks.push({
      name: `${node.nodeId}'s attested ledger independently verifies`,
      passed: result.valid,
      detail: `${result.totalEntries} entries, brokenAtSeq=${result.brokenAtSeq}, invalidSignatureAtSeq=${result.invalidSignatureAtSeq}`,
    });
  }

  return { passed: checks.every((c) => c.passed), checks };
}

function envelope(nodeId: string, round: number, kind: SwarmEnvelope['kind'], value: string, payload: unknown): SwarmEnvelope {
  return { nodeId, round, kind, value, payload };
}
