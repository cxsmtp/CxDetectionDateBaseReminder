// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Which discovered repositories are measured, and the same repository reached twice counted once.
// Pure, shared by the CLI scan and the standalone HTML page.
import { globToRegExp } from './languages.js';

/** A connection's repositories in one organization, each with why it is skipped (or null). */
/**
 * What "every organization" means for a connection: every organization the sign-in lists, plus,
 * where the platform can list it, every other repository it can reach (personal, collaborator,
 * other namespaces) unless includePersonal is false. Duplicates are removed later (dedupeRepos).
 */
export function allOrgIds(listed, conn) {
  const ids = listed.map((o) => o.id).filter((id) => id !== '@me');
  if (conn.includePersonal !== false && listed.some((o) => o.id === '@me')) ids.push('@all');
  return ids;
}

export function classifyRepos(cfg, conn, org, list, overrideFor) {
  const inc = (conn.include || []).map(globToRegExp);
  const exc = (conn.exclude || []).map(globToRegExp);
  return list.map((r) => {
    // Personal and cross-namespace listings are grouped under each repository's real owner.
    const repo = { ...r, provider: conn.provider, connection: conn.name, org: org.startsWith('@') && r.fullName ? r.fullName.split('/')[0] : org };
    const o = overrideFor(repo);
    let skip = null;
    if (!cfg.includeArchived && repo.archived) skip = 'archived';
    else if (!cfg.includeForks && repo.fork) skip = 'fork';
    else if (inc.length && !inc.some((re) => re.test(repo.fullName))) skip = 'not included';
    else if (exc.some((re) => re.test(repo.fullName))) skip = 'excluded';
    else if (o.exclude) skip = 'excluded by override';
    return { ...repo, skip, criticality: o.criticality ?? null, scansOverride: o.scans ?? null, modelOverride: o.model ?? null, locOverride: o.loc ?? null };
  });
}

/**
 * The same repository reached twice (two connections, or a group and a subgroup) counts once; a
 * copy that is measured wins over one that is skipped.
 */
export function dedupeRepos(repos) {
  const byKey = new Map();
  for (const r of repos) {
    const k = r.cloneUrl?.toLowerCase().replace(/\.git$/, '') || `${r.connection}|${r.fullName}`;
    const had = byKey.get(k);
    if (!had || (had.skip && !r.skip)) byKey.set(k, r);
  }
  return [...byKey.values()];
}
