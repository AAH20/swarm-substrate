#!/usr/bin/env node
/**
 * Runs the adversarial scenario and prints the report. `npm run demo` after
 * building — this is the same scenario the test suite asserts against, run
 * here for a human to read instead of a test runner to assert on.
 */
import { runAdversarialScenario } from './redteam.js';

const report = await runAdversarialScenario();

for (const check of report.checks) {
  const mark = check.passed ? '✓' : '✗';
  console.log(`${mark} ${check.name}`);
  if (!check.passed) console.log(`    ${check.detail}`);
}

console.log('');
console.log(report.passed ? 'PASSED — every guarantee held.' : 'FAILED — see above.');
process.exitCode = report.passed ? 0 : 1;
