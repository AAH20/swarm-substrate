import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionIntoCommittees, tallyHierarchical } from '../src/committee-consensus.js';

test('partitions nodes into fixed-size committees, remainder in the last one', () => {
  const committees = partitionIntoCommittees(['n1', 'n2', 'n3', 'n4', 'n5'], 2);
  assert.equal(committees.length, 3);
  assert.deepEqual(committees[2]!.memberIds, ['n5']);
});

test('global decision holds even when one entire committee is compromised', () => {
  // 4 committees of 4 nodes each (16 total). Committees A-C are fully
  // honest and decide unanimously. Committee D has 2 byzantine members —
  // a 2-2 split inside a 4-member committee can never reach that
  // committee's local quorum (3), so it abstains at the meta-level.
  const committeeA = { committeeId: 'A', totalMembers: 4, votes: vote4('action-A', 'action-A', 'action-A', 'action-A') };
  const committeeB = { committeeId: 'B', totalMembers: 4, votes: vote4('action-A', 'action-A', 'action-A', 'action-A') };
  const committeeC = { committeeId: 'C', totalMembers: 4, votes: vote4('action-A', 'action-A', 'action-A', 'action-A') };
  const committeeD = { committeeId: 'D', totalMembers: 4, votes: vote4('action-A', 'action-A', 'action-B', 'action-B') };

  const result = tallyHierarchical([committeeA, committeeB, committeeC, committeeD]);

  assert.equal(committeeD.votes.length, 4);
  const dOutcome = result.committeeOutcomes.find((o) => o.committeeId === 'D')!;
  assert.equal(dOutcome.result.decided, false, 'a 2-2 split committee must not reach local quorum');

  assert.equal(result.decided, true, 'global decision must hold on the 3 honest committees alone');
  assert.equal(result.value, 'action-A');
  assert.equal(result.metaQuorum, 3);
});

test('global decision fails if too many committees disagree or abstain', () => {
  const committeeA = { committeeId: 'A', totalMembers: 4, votes: vote4('action-A', 'action-A', 'action-A', 'action-A') };
  const committeeB = { committeeId: 'B', totalMembers: 4, votes: vote4('action-B', 'action-B', 'action-B', 'action-B') };
  const committeeC = { committeeId: 'C', totalMembers: 4, votes: vote4('action-A', 'action-A', 'action-B', 'action-B') };

  const result = tallyHierarchical([committeeA, committeeB, committeeC]);
  assert.equal(result.decided, false);
});

function vote4(a: string, b: string, c: string, d: string) {
  return [
    { nodeId: 'm1', value: a },
    { nodeId: 'm2', value: b },
    { nodeId: 'm3', value: c },
    { nodeId: 'm4', value: d },
  ];
}
