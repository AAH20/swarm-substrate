/**
 * Minimal single-round Byzantine quorum.
 *
 * This is deliberately not a full consensus protocol — no view changes, no
 * leader election, no handling of network partitions or asynchrony. It's
 * the smallest real quorum rule that demonstrates the property that
 * matters here: with `n` total nodes and a quorum of `floor(2n/3) + 1`, the
 * honest majority reaches agreement regardless of what a minority of
 * faulty/dishonest votes claim, as long as faulty nodes number fewer than
 * `n/3` (the standard `n >= 3f + 1` Byzantine bound). Building a
 * production consensus protocol (PBFT, Tendermint, HotStuff) is a
 * substantially larger undertaking than this reference stack attempts;
 * this module exists to prove the composition, not to replace them.
 */
export interface Vote {
  readonly nodeId: string;
  readonly value: string;
}

export interface ConsensusResult {
  readonly decided: boolean;
  readonly value: string | undefined;
  readonly tally: Readonly<Record<string, number>>;
  readonly quorum: number;
  readonly totalNodes: number;
  readonly votesCounted: number;
}

export function quorumFor(totalNodes: number): number {
  return Math.floor((2 * totalNodes) / 3) + 1;
}

/** Tally `votes` against a quorum computed from `totalNodes` (the swarm's full membership, not just active voters). */
export function tallyVotes(votes: readonly Vote[], totalNodes: number): ConsensusResult {
  const tally: Record<string, number> = {};
  for (const vote of votes) {
    tally[vote.value] = (tally[vote.value] ?? 0) + 1;
  }

  const quorum = quorumFor(totalNodes);
  let decided = false;
  let winner: string | undefined;
  for (const [value, count] of Object.entries(tally)) {
    if (count >= quorum) {
      decided = true;
      winner = value;
      break;
    }
  }

  return {
    decided,
    value: winner,
    tally,
    quorum,
    totalNodes,
    votesCounted: votes.length,
  };
}
