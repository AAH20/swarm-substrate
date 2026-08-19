import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyVotes, quorumFor } from '../src/consensus.js';

test('quorum is floor(2n/3) + 1', () => {
  assert.equal(quorumFor(4), 3);
  assert.equal(quorumFor(1), 1);
  assert.equal(quorumFor(3), 3);
  assert.equal(quorumFor(7), 5);
});

test('honest majority decides despite one dissenting vote', () => {
  const result = tallyVotes(
    [
      { nodeId: 'n1', value: 'A' },
      { nodeId: 'n2', value: 'A' },
      { nodeId: 'n3', value: 'A' },
      { nodeId: 'n4', value: 'B' },
    ],
    4,
  );
  assert.equal(result.decided, true);
  assert.equal(result.value, 'A');
  assert.equal(result.quorum, 3);
});

test('no quorum when votes are too split', () => {
  const result = tallyVotes(
    [
      { nodeId: 'n1', value: 'A' },
      { nodeId: 'n2', value: 'B' },
      { nodeId: 'n3', value: 'C' },
      { nodeId: 'n4', value: 'D' },
    ],
    4,
  );
  assert.equal(result.decided, false);
  assert.equal(result.value, undefined);
});

test('quorum is computed against total swarm membership, not just votes cast', () => {
  // Only 2 of 4 members voted — even unanimous, that's below quorum(4)=3.
  const result = tallyVotes(
    [
      { nodeId: 'n1', value: 'A' },
      { nodeId: 'n2', value: 'A' },
    ],
    4,
  );
  assert.equal(result.decided, false);
});
