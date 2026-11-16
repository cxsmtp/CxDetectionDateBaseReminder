// The order in which the server registers its middleware and routes is behaviour (Express runs them in that
// order): the body parsers for each path, the licence gate, the sign-in and permission checks, the static files,
// the error handler. The routes are registered by src/server.js and by the modules it calls, one after the other;
// this compares what the running app has registered with the list kept in test/fixtures/routes.txt, so that
// moving a call, a route or a guard cannot change the order unnoticed.
//
// After a change that is meant (a new route, a new guard): `node scripts/list-routes.mjs --write`, and look at the
// difference in test/fixtures/routes.txt before committing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SNAPSHOT, listRoutes } from '../scripts/list-routes.mjs';

test('middleware and routes are registered in the order kept in test/fixtures/routes.txt', async () => {
  const live = (await listRoutes()).split('\n');
  const kept = fs.readFileSync(SNAPSHOT, 'utf8').split('\n');
  // The first line that differs says where; the whole lists say what.
  const at = live.findIndex((line, i) => line !== kept[i]);
  assert.deepEqual(live, kept, at < 0 ? 'the list is shorter than the one kept' : `line ${at + 1}: registered "${live[at]}", kept "${kept[at] ?? '(nothing)'}". If the change is meant: node scripts/list-routes.mjs --write`);
});

test('the list has the parts the order is about', () => {
  const kept = fs.readFileSync(SNAPSHOT, 'utf8').split('\n').filter(Boolean);
  const first = (re) => kept.findIndex((line) => re.test(line));
  assert.ok(kept.length > 300, 'every route is listed');
  // Body parsers for their own paths come before the one for everything else, and all of them before any route.
  assert.ok(first(/^USE\s+\/api\/relay\s+\[jsonParser\]/) < first(/^USE\s+\(every request\)\s+\[jsonParser\]/));
  assert.ok(first(/^USE\s+\(every request\)\s+\[jsonParser\]/) < first(/^(GET|POST|PUT|PATCH|DELETE)\s/));
  // The error handler is the last thing registered.
  assert.match(kept.at(-1), /\(error handler\)\]$/);
  assert.equal(kept.filter((line) => /\(error handler\)/.test(line)).length, 1);
});
