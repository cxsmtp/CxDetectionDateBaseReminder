// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
import github from './github.js';
import gitlab from './gitlab.js';
import azure from './azure.js';
import bitbucket from './bitbucket.js';
import bitbucketServer from './bitbucket-server.js';
import generic from './generic.js';

export const PROVIDERS = [github, gitlab, azure, bitbucket, bitbucketServer, generic];

export function providerOf(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider "${id}" (expected one of: ${PROVIDERS.map((x) => x.id).join(', ')})`);
  return p;
}
