import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAdversarialScenario } from '../src/redteam.js';

test('the full adversarial swarm scenario passes every independent check', async () => {
  const report = await runAdversarialScenario();
  for (const check of report.checks) {
    assert.equal(check.passed, true, `${check.name} — ${check.detail}`);
  }
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 11);
});
