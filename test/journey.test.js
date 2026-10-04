// The way to Mission Zero: every open finding is in exactly one stage.
import test from 'node:test';
import assert from 'node:assert/strict';

import { journeyOf } from '../src/journey.js';

test('each finding is counted once, in the stage it has reached', () => {
  const risks = [
    { riskId: 'a', state: 'TO_VERIFY' },
    { riskId: 'b', state: '' },
    { riskId: 'c', state: 'CONFIRMED' },
    { riskId: 'd', state: 'URGENT' },
    { riskId: 'e', state: 'CONFIRMED' }, // a fix was asked for
    { riskId: 'f', state: 'NOT_EXPLOITABLE' },
    { riskId: 'g', state: 'PROPOSED_NOT_EXPLOITABLE' },
  ];
  const j = journeyOf(risks, new Set(['e']));
  assert.deepEqual(j, { open: 5, toTriage: 2, toRemediate: 2, fixing: 1, notExploitable: 2 });
  assert.equal(j.toTriage + j.toRemediate + j.fixing, j.open);
});
