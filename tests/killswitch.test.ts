import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KillSwitch } from '../src/killswitch.js';

test('does not trip before threshold', () => {
  const ks = new KillSwitch(2);
  const r1 = ks.recordViolation('n1');
  assert.equal(r1.count, 1);
  assert.equal(r1.tripped, false);
  assert.equal(ks.isQuarantined('n1'), false);
});

test('trips exactly at threshold, not before or after', () => {
  const ks = new KillSwitch(2);
  ks.recordViolation('n1');
  const r2 = ks.recordViolation('n1');
  assert.equal(r2.count, 2);
  assert.equal(r2.tripped, true);
  assert.equal(ks.isQuarantined('n1'), true);
});

test('does not report "tripped" again on further violations after quarantine', () => {
  const ks = new KillSwitch(2);
  ks.recordViolation('n1');
  ks.recordViolation('n1');
  const r3 = ks.recordViolation('n1');
  assert.equal(r3.count, 3);
  assert.equal(r3.tripped, false, 'already quarantined — this is not a new trip event');
  assert.equal(ks.isQuarantined('n1'), true);
});

test('nodes are tracked independently', () => {
  const ks = new KillSwitch(2);
  ks.recordViolation('n1');
  ks.recordViolation('n1');
  assert.equal(ks.isQuarantined('n1'), true);
  assert.equal(ks.isQuarantined('n2'), false);
  assert.deepEqual(ks.quarantinedNodes(), ['n1']);
});

test('rejects a non-positive threshold', () => {
  assert.throws(() => new KillSwitch(0));
});
