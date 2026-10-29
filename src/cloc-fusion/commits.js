// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Commit statistics from a platform's commit list. Pure, shared by the API engine and the
// standalone HTML page.

const DAY = 86400000;

/** Contributing developers are counted over this many days (the usual licensing window). */
export const DEV_WINDOW_DAYS = 90;
// Automation accounts: GitHub Apps ("…[bot]"), and well-known bots and CI users. More can be
// named in the configuration ("bots": ["svc-*", "*jenkins*"]).
const BOT = /\[bot\]|^(dependabot|renovate|github-actions|snyk-bot|greenkeeper|azure-pipelines|gitlab-bot|semantic-release-bot|mergify|codecov|jenkins|whitesource|mend-bolt)\b|^noreply@github\.com$|^action@github\.com$/i;

/** Is this commit author an automation account (by email or name)? */
export const isBot = (email, name = '') => BOT.test(String(email || '').trim()) || BOT.test(String(name || '').trim());

/** The key a contributor is known by: the lower-cased email, else the name. */
export const contributorKey = (c) => (c.email ? String(c.email).trim().toLowerCase() : c.name ? `name:${String(c.name).trim()}` : '');

/**
 * Everyone who committed in the last DEV_WINDOW_DAYS, from the commit history: [{ email, name,
 * commits, lastCommitAt, bot }], busiest first; and the counts of developers (people) and bots.
 */
export function contributorsOf(commits, now = Date.now()) {
  const since = now - DEV_WINDOW_DAYS * DAY;
  const byKey = new Map();
  for (const c of commits) {
    if (!(c.t >= since)) continue;
    const key = contributorKey(c);
    if (!key) continue;
    const had = byKey.get(key);
    if (had) {
      had.commits++;
      if (c.t > had.t) Object.assign(had, { t: c.t, name: c.name || had.name });
    } else byKey.set(key, { email: c.email ? String(c.email).trim() : '', name: String(c.name || '').trim(), commits: 1, t: c.t });
  }
  const contributors90 = [...byKey.values()]
    .map(({ t, ...c }) => ({ ...c, lastCommitAt: new Date(t).toISOString(), bot: isBot(c.email, c.name) }))
    .sort((a, b) => b.commits - a.commits || a.email.localeCompare(b.email));
  const bots90 = contributors90.filter((c) => c.bot).length;
  return { devs90: contributors90.length - bots90, bots90, contributors90 };
}

/** Commit stats from [{ t, email, merge }]: count, authors, last commit, weekly series. */
export function statsFromCommits(list, { now = Date.now(), sinceT = 0, includeMerges = false, weeks = 52 } = {}) {
  const weekly = new Array(weeks).fill(0);
  const authors = new Set();
  const counted = [];
  let commits = 0;
  let last = null;
  for (const c of list) {
    if (!Number.isFinite(c.t) || c.t < sinceT) continue;
    if (c.merge && !includeMerges) continue;
    commits++;
    counted.push(c);
    if (c.email) authors.add(String(c.email).toLowerCase());
    if (last === null || c.t > last) last = c.t;
    const w = Math.floor((now - c.t) / (7 * DAY));
    if (w >= 0 && w < weeks) weekly[weeks - 1 - w]++;
  }
  return { commits, authors: authors.size, weekly, lastCommitAt: last ? new Date(last).toISOString() : null, ...contributorsOf(counted, now) };
}
