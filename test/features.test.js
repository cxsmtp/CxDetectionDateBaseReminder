// Beta features and making them final: which stage a feature is in, and who may use it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { FEATURES, featureList, isFinal, mayUse, mergeFeatures } from '../src/features.js';
import { mergeAutomation, DEFAULT_AUTOMATION } from '../src/automation-config.js';

test('a feature is Beta until made final; only known features and stages are kept', () => {
  assert.deepEqual(FEATURES.map((f) => f.id), ['codeAuthors', 'sla', 'identityMatching']);
  assert.equal(isFinal({}, 'codeAuthors'), false);
  const stored = mergeFeatures({}, { codeAuthors: { stage: 'final', by: 'admin@acme.io' }, bogus: { stage: 'final' }, identityMatching: { stage: 'gold' } });
  assert.deepEqual(Object.keys(stored), ['codeAuthors']);
  assert.equal(stored.codeAuthors.by, 'admin@acme.io');
  assert.ok(stored.codeAuthors.at, 'when it changed');
  assert.equal(isFinal({ features: stored }, 'codeAuthors'), true);
  assert.deepEqual(mergeFeatures(stored, { codeAuthors: { stage: 'beta' } }).codeAuthors.stage, 'beta');
  assert.deepEqual(featureList({ features: stored }).map((f) => f.stage), ['final', 'beta', 'beta']);
});

test('Beta access always works; a final feature is open to its own permission too', () => {
  const beta = {};
  const final = { features: { codeAuthors: { stage: 'final' } } };
  const user = new Set(['reminders.send']);
  assert.equal(mayUse(beta, 'codeAuthors', new Set(['beta.use'])), true);
  assert.equal(mayUse(beta, 'codeAuthors', user), false, 'still Beta');
  assert.equal(mayUse(final, 'codeAuthors', user), true, 'final: whoever may send reminders');
  assert.equal(mayUse(final, 'identityMatching', user), false, 'the other one is still Beta');
  assert.equal(mayUse(final, 'nope', user), false);
});

test('scheduled reminders: emailing code authors is off by default, and only a true turns it on', () => {
  assert.equal(DEFAULT_AUTOMATION.notifyCodeAuthors, false);
  assert.equal(mergeAutomation(DEFAULT_AUTOMATION, { notifyCodeAuthors: true }).notifyCodeAuthors, true);
  assert.equal(mergeAutomation(DEFAULT_AUTOMATION, { notifyCodeAuthors: 'yes' }).notifyCodeAuthors, false);
});
