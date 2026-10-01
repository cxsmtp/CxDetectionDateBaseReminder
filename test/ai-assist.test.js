import test from 'node:test';
import assert from 'node:assert/strict';

import { CxClient } from '../src/cxone/client.js';
import { groupIdFor, resolveAiIds } from '../src/cxone/ai-assist.js';

/** A client whose /api/results pages come from `pages[scanId]`, indexed by page number. */
function fakeClient(pages) {
  const calls = [];
  const client = new CxClient({ baseUrl: 'https://x' }, { getToken: async () => 't', reset() {} });
  client.request = async (path, { query }) => {
    calls.push({ path, ...query });
    return { results: pages[query['scan-id']]?.[query.offset] ?? [], totalCount: 1 };
  };
  return { client, calls };
}

const finding = (overrides) => ({ projectId: 'p1', scanId: '', scanner: 'SAST', groupId: '', ...overrides });

test('SAST findings get their alternateId from /api/results by similarityId (the groupId)', async () => {
  const { client } = fakeClient({
    s1: [[{ type: 'sast', similarityId: -55, alternateId: 'alt-sast', state: 'TO_VERIFY' }, { type: 'sca', similarityId: -55, alternateId: 'wrong-type' }]],
  });
  const f = finding({ groupId: '-55' });
  await resolveAiIds(client, [f], () => 's1');
  assert.equal(f.alternateId, 'alt-sast');
  assert.equal(f.scanId, 's1');
  assert.equal(f.groupId, '-55');
  assert.equal(f.state, 'TO_VERIFY');
  assert.equal(f.aiUnavailable, undefined);
});

test('SCA findings are told apart by packageIdentifier and get the documented groupId shape', async () => {
  const { client } = fakeClient({
    s1: [[
      { type: 'sca', similarityId: 'CVE-1', alternateId: 'alt-a', data: { packageIdentifier: 'npm-a-1.0' } },
      { type: 'sca', similarityId: 'CVE-1', alternateId: 'alt-b', data: { packageIdentifier: 'npm-b-2.0' } },
    ]],
  });
  const f = finding({ scanner: 'SCA', scanId: 's1', groupId: 'CVE-1#-#npm-b-2.0#-#p1' });
  await resolveAiIds(client, [f]);
  assert.equal(f.alternateId, 'alt-b');
  assert.equal(groupIdFor({ scanner: 'SCA', projectId: 'p9', similarityId: 'CVE-2', packageIdentifier: 'pkg' }), 'CVE-2#-#pkg#-#p9');
});

test('findings that cannot be resolved are marked unavailable, never thrown', async () => {
  const { client } = fakeClient({ s1: [[]] });
  const iac = finding({ scanner: 'KICS' });
  const missing = finding({ groupId: '7', scanId: 's1' });
  const noScan = finding({ groupId: '8' });
  await resolveAiIds(client, [iac, missing, noScan], () => '');
  assert.match(iac.aiUnavailable, /SAST and SCA only/);
  assert.match(missing.aiUnavailable, /not found in the latest scan results/);
  assert.match(noScan.aiUnavailable, /No completed scan/);
});

test('/api/results is paged by page number and read until a short page, ignoring totalCount', async () => {
  const full = Array.from({ length: 500 }, (_, i) => ({ type: 'sast', similarityId: i, alternateId: `a${i}` }));
  const { client, calls } = fakeClient({ s1: [full, [{ type: 'sast', similarityId: 'last', alternateId: 'on-page-2' }]] });
  const f = finding({ groupId: 'last', scanId: 's1' });
  await resolveAiIds(client, [f]);
  assert.deepEqual(calls.map((c) => c.offset), [0, 1]);
  assert.equal(f.alternateId, 'on-page-2');
});

test('an SCA finding is never matched to the same vulnerability in another package version', async () => {
  // The latest scan only has CVE-9 in crypto v0.51.0; the finding is about v0.21.0.
  const { client } = fakeClient({
    s1: [[{ type: 'sca', similarityId: 'CVE-9', alternateId: 'alt-051', data: { packageIdentifier: 'Go-golang.org/x/crypto-v0.51.0' } }]],
  });
  const stale = finding({ scanner: 'SCA', groupId: 'CVE-9#-#Go-golang.org/x/crypto-v0.21.0#-#p1' });
  const current = finding({ scanner: 'SCA', groupId: 'CVE-9#-#Go-golang.org/x/crypto-v0.51.0#-#p1' });
  await resolveAiIds(client, [stale, current], () => 's1');
  assert.equal(stale.alternateId, undefined, 'not triaged (and charged) as someone else');
  assert.match(stale.aiUnavailable, /not found in the latest scan results/);
  assert.equal(current.alternateId, 'alt-051');
});
