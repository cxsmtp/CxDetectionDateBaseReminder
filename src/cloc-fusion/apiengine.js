// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// The git-free engine: measures a repository through its platform's API alone. Lines of code come
// from the default branch's archive, streamed and counted in memory (nothing is written to disk
// except Azure DevOps' zip, held in a temporary file while it is read); commits come from the
// platform's commit list. Needs nothing installed. Uses more API calls than the git engine, so on
// very large estates the git engine is faster and gentler on rate limits.
import { createWriteStream } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readTarGz, readZipFile, stripTop } from './archive.js';
import { makeSelector, LocTally } from './loc.js';
import { statsFromCommits } from './commits.js';

export { statsFromCommits } from './commits.js';

const DAY = 86400000;

/** Measure one repository through the API. Same result shape as git.js analyzeRepo. */
export async function analyzeRepoApi(repo, { session, conn, workDir, windowDays = 365, includeMerges = false, exclude = [], include = [], maxFileBytes = 2 * 1024 * 1024, maxArchiveBytes, countCategories, locBasis, now = Date.now(), onPhase = () => {} }) {
  const { provider, api } = session;
  if (!provider.archive || !api) throw new Error(`the git-free engine does not support ${provider.label}; install git (or use --engine git)`);
  if (!repo.defaultBranch) return { empty: true, commits: 0, authors: 0, devs90: 0, bots90: 0, contributors90: [], windowDays, weekly: [], loc: 0, files: 0, code: 0, comment: 0, blank: 0, languages: {}, mainLanguage: null };
  const since = new Date(now - windowDays * DAY).toISOString();

  onPhase('history');
  const history = await provider.commits(api, repo, since, conn);
  const stats = statsFromCommits(history.commits, { now, sinceT: Date.parse(since), includeMerges });
  stats.lastCommitAt ??= history.lastCommitAt ? new Date(history.lastCommitAt).toISOString() : null;
  let effectiveWindow = windowDays;
  if (repo.createdAt) {
    const age = (now - Date.parse(repo.createdAt)) / DAY;
    if (Number.isFinite(age) && age > 0) effectiveWindow = Math.min(windowDays, Math.max(1, age));
  }

  onPhase('files');
  const tally = new LocTally();
  let treeFiles = 0;
  const select = makeSelector({ exclude, include, maxFileBytes });
  const onEntry = (e) => {
    treeFiles++;
    e.path = e.format === 'zip' ? e.path : stripTop(e.path);
    e.lang = select(e.path, e.size);
    return Boolean(e.lang);
  };
  const onFile = (e, content) => tally.add(e.lang, content);
  const { url, format } = provider.archive(repo, conn);
  const res = await api.download(url);
  if (format === 'zip') {
    await mkdir(workDir, { recursive: true });
    const tmp = join(workDir, `archive-${randomBytes(6).toString('hex')}.zip`);
    try {
      await pipeline(Readable.fromWeb(res.body), byteLimit(maxArchiveBytes ?? 4 * 1024 ** 3), createWriteStream(tmp, { mode: 0o600 }));
      onPhase('count');
      await readZipFile(tmp, { onEntry: (e) => onEntry(Object.assign(e, { format: 'zip' })), onFile, maxFileBytes, maxArchiveBytes });
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  } else {
    onPhase('count');
    await readTarGz(Readable.fromWeb(res.body), { onEntry, onFile, maxFileBytes, maxArchiveBytes });
  }
  const sum = tally.summary({ countCategories, locBasis });
  return {
    headSha: null,
    branch: repo.defaultBranch,
    commits: stats.commits,
    authors: stats.authors,
    devs90: stats.devs90,
    bots90: stats.bots90,
    contributors90: stats.contributors90,
    weekly: stats.weekly,
    lastCommitAt: stats.lastCommitAt,
    windowDays: Math.round(effectiveWindow * 10) / 10,
    treeFiles,
    engine: 'api',
    ...sum,
  };
}

function byteLimit(limit) {
  let seen = 0;
  return async function* (source) {
    for await (const chunk of source) {
      seen += chunk.length;
      if (seen > limit) throw new Error(`the archive is larger than ${Math.round(limit / 1048576)} MB (raise maxArchiveBytes, or use the git engine)`);
      yield chunk;
    }
  };
}
