/**
 * Hierarchical Byzantine consensus: partitions the swarm into committees,
 * runs the existing single-round quorum (`consensus.ts`) inside each one,
 * then treats each committee's local decision as one vote in a meta-round.
 *
 * This is the scaling answer for flat BFT quorum voting, which is O(n²)
 * message complexity — fine at n=4, dead on arrival at swarm scale.
 * Splitting into small committees keeps each local round cheap; the
 * fault-tolerance property that matters carries up a level too: this
 * design tolerates an *entire committee* being compromised, not just a
 * minority of individual nodes within one committee, as long as fewer than
 * a third of committees are compromised.
 */
import { tallyVotes, quorumFor, type Vote, type ConsensusResult } from './consensus.js';

export interface Committee {
  readonly id: string;
  readonly memberIds: readonly string[];
}

/** Splits `nodeIds` into committees of `committeeSize`. The last committee is shorter if `nodeIds.length` doesn't divide evenly. */
export function partitionIntoCommittees(nodeIds: readonly string[], committeeSize: number): Committee[] {
  if (committeeSize < 1) throw new Error('committeeSize must be at least 1');
  const committees: Committee[] = [];
  for (let i = 0; i < nodeIds.length; i += committeeSize) {
    const memberIds = nodeIds.slice(i, i + committeeSize);
    committees.push({ id: `committee-${committees.length}`, memberIds });
  }
  return committees;
}

export interface CommitteeVotes {
  readonly committeeId: string;
  readonly votes: readonly Vote[];
  readonly totalMembers: number;
}

export interface CommitteeOutcome {
  readonly committeeId: string;
  readonly result: ConsensusResult;
}

export interface HierarchicalConsensusResult {
  readonly decided: boolean;
  readonly value: string | undefined;
  readonly committeeOutcomes: readonly CommitteeOutcome[];
  readonly metaQuorum: number;
  readonly totalCommittees: number;
}

/**
 * Tally votes within each committee, then tally committee-level decisions
 * against a meta-quorum over `totalCommittees` (a committee that fails to
 * reach local quorum contributes no meta-vote — it abstains rather than
 * blocking).
 */
export function tallyHierarchical(committeeVotes: readonly CommitteeVotes[]): HierarchicalConsensusResult {
  const committeeOutcomes: CommitteeOutcome[] = committeeVotes.map((cv) => ({
    committeeId: cv.committeeId,
    result: tallyVotes(cv.votes, cv.totalMembers),
  }));

  const totalCommittees = committeeVotes.length;
  const metaVotes: Vote[] = committeeOutcomes
    .filter((outcome) => outcome.result.decided && outcome.result.value !== undefined)
    .map((outcome) => ({ nodeId: outcome.committeeId, value: outcome.result.value! }));

  const metaResult = tallyVotes(metaVotes, totalCommittees);

  return {
    decided: metaResult.decided,
    value: metaResult.value,
    committeeOutcomes,
    metaQuorum: quorumFor(totalCommittees),
    totalCommittees,
  };
}
