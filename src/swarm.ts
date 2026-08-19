/**
 * Orchestrates one round: runs every submitted envelope through kill-switch
 * enforcement, then integrity checking, then provenance, then (for votes)
 * consensus tallying — in that order, because each layer's output gates the
 * next. A quarantined node's envelope never reaches integrity checking; a
 * rejected envelope still gets attested but never reaches the consensus
 * tally.
 */
import type { LedgerStore, AttestationEntry } from 'pqattest';
import type { SwarmEnvelope } from './schema.js';
import type { SwarmNode } from './provenance.js';
import { checkIntegrity } from './integrity.js';
import { attestEnvelope } from './provenance.js';
import { KillSwitch, type ViolationResult } from './killswitch.js';
import { tallyVotes, type ConsensusResult } from './consensus.js';

export interface SwarmConfig {
  readonly nodes: readonly SwarmNode[];
  readonly store: LedgerStore;
  readonly killSwitch: KillSwitch;
}

export interface EnvelopeOutcome {
  readonly nodeId: string;
  readonly excludedAsQuarantined: boolean;
  readonly integrityViolation: string | undefined;
  readonly attestation: AttestationEntry | undefined;
  readonly violationResult: ViolationResult | undefined;
}

export interface RoundResult {
  readonly round: number;
  readonly outcomes: readonly EnvelopeOutcome[];
  readonly consensus: ConsensusResult | undefined;
}

export async function runRound(config: SwarmConfig, round: number, envelopes: readonly SwarmEnvelope[]): Promise<RoundResult> {
  const nodesById = new Map(config.nodes.map((n) => [n.nodeId, n]));
  const outcomes: EnvelopeOutcome[] = [];
  const cleanVotes: { nodeId: string; value: string }[] = [];
  let sawVote = false;

  for (const envelope of envelopes) {
    const node = nodesById.get(envelope.nodeId);
    if (!node) throw new Error(`unknown node: ${envelope.nodeId}`);

    if (config.killSwitch.isQuarantined(envelope.nodeId)) {
      outcomes.push({
        nodeId: envelope.nodeId,
        excludedAsQuarantined: true,
        integrityViolation: undefined,
        attestation: undefined,
        violationResult: undefined,
      });
      continue;
    }

    const violation = checkIntegrity(envelope);
    const violationResult = violation ? config.killSwitch.recordViolation(envelope.nodeId) : undefined;

    const attestation = await attestEnvelope({
      store: config.store,
      node,
      envelope,
      integrityViolation: violation?.reason,
    });

    if (envelope.kind === 'vote') {
      sawVote = true;
      if (!violation) cleanVotes.push({ nodeId: envelope.nodeId, value: envelope.value });
    }

    outcomes.push({
      nodeId: envelope.nodeId,
      excludedAsQuarantined: false,
      integrityViolation: violation?.reason,
      attestation,
      violationResult,
    });
  }

  const consensus = sawVote ? tallyVotes(cleanVotes, config.nodes.length) : undefined;

  return { round, outcomes, consensus };
}
