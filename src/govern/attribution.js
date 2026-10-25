/**
 * Govern (beta): who each consumption row counts towards (SPEC §5).
 *
 * Users: an admin's decision first (pinned → that user; ignored → nobody), then the exact ladder (email; an
 * email-shaped name; username; the username without its service prefix, as directory.js normalises it; the
 * full name, only when unambiguous), then a fuzzy match restricted to candidates the admin has not rejected.
 * Below 0.85, or a runner-up within 0.05, it is a dispute; under 0.60 nobody is suggested. Bots are never matched,
 * automation pseudo-users never count at user level.
 * Projects, applications and groups: by reported id, then by unique name; duplicate names are disputes and
 * unknown names unmatched — they go to the same queue, so their credits never escape every budget silently.
 *
 * Decisions are sticky (B8): `pinned`, `rejected` (never auto-attribute to these again), `ignored`; they are
 * carried to aliases — another subject whose tokens normalise to the same set. A pin to someone no longer in
 * Checkmarx One is kept but flagged, and the subject goes back to the disputes.
 */
import { normalizeUsername } from '../cxone/directory.js';
import { isAutomation } from './ingest.js';
import { cleanId, cleanText, fail } from './store.js';

export const ATTRIBUTED_DIMENSIONS = ['user', 'project', 'application', 'group'];
export const COUNTED = new Set(['exact', 'pinned', 'auto']);
const BOTS = new Set(['dependabot', 'renovate', 'github-actions', 'snyk-bot', 'codecov', 'mergify', 'greenkeeper']);
const SUGGEST = 0.6;
const AUTO = 0.85;
const MARGIN = 0.05;

/** Lower-case tokens of a name or address: an address becomes its local part; a cx/svc/srv prefix and 1-letter tokens go. */
export function tokens(value) {
  let s = String(value ?? '').toLowerCase().trim();
  if (s.includes('@')) s = s.split('@')[0];
  const list = s.split(/[^a-z0-9]+/).filter(Boolean);
  if (list.length > 1 && ['cx', 'svc', 'srv'].includes(list[0])) list.shift();
  return list.filter((t) => t.length > 1);
}

export const signature = (value) => [...new Set(tokens(value))].sort().join(' ');

export function isBot(name) {
  const s = String(name ?? '').toLowerCase().trim();
  if (s.includes('[bot]')) return true;
  const local = s.split('@')[0].replace(/\[bot\]$/, '');
  return BOTS.has(s) || BOTS.has(local);
}

/** Ratcliff/Obershelp similarity (what Python's SequenceMatcher.ratio gives), for short strings. */
export function ratio(a, b) {
  if (!a.length && !b.length) return 1;
  const matches = (x, y) => {
    if (!x.length || !y.length) return 0;
    let best = 0;
    let bi = 0;
    let bj = 0;
    for (let i = 0; i < x.length; i += 1) {
      for (let j = 0; j < y.length; j += 1) {
        let k = 0;
        while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k += 1;
        if (k > best) [best, bi, bj] = [k, i, j];
      }
    }
    if (!best) return 0;
    return best + matches(x.slice(0, bi), y.slice(0, bj)) + matches(x.slice(bi + best), y.slice(bj + best));
  };
  return (2 * matches(a.slice(0, 200), b.slice(0, 200))) / (Math.min(a.length, 200) + Math.min(b.length, 200));
}

/** How alike two token sets are, 0…1 (SPEC §5.1 step 4). */
export function score(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common += 1;
  if (common === A.size && common === B.size) return 1;
  const union = new Set([...A, ...B]).size;
  const set = 0.6 * (common / Math.min(A.size, B.size)) + 0.4 * (common / union);
  return Math.max(set, ratio([...A].sort().join(''), [...B].sort().join('')));
}

const add = (map, key, value) => {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
};
const only = (set) => (set && set.size === 1 ? [...set][0] : null);

/** Lookups over the org's users, made once per cycle. */
export function indexUsers(users) {
  const byEmail = new Map();
  const byUsername = new Map();
  const byNormalized = new Map();
  const byFullName = new Map();
  const profiles = [];
  for (const u of users.values()) {
    if (u.enabled === false) continue;
    add(byEmail, u.email, u.id);
    if (u.username.includes('@')) add(byEmail, u.username, u.id);
    add(byUsername, u.username, u.id);
    add(byNormalized, normalizeUsername(u.username), u.id);
    if (u.email) add(byNormalized, normalizeUsername(u.email), u.id);
    const full = `${u.firstName} ${u.lastName}`.trim().toLowerCase().replace(/\s+/g, ' ');
    if (full.includes(' ')) add(byFullName, full, u.id);
    profiles.push({ id: u.id, label: labelOfUser(u), tokens: [...new Set([...tokens(`${u.firstName} ${u.lastName}`), ...tokens(u.email), ...tokens(u.username), ...tokens(u.firstName), ...tokens(u.lastName)])] });
  }
  return { byEmail, byUsername, byNormalized, byFullName, profiles };
}

export const labelOfUser = (u) => (u ? [`${u.firstName} ${u.lastName}`.trim(), u.email || u.username].filter(Boolean).join(' · ') || u.id : '');

/** The exact ladder for one user row: a user id, or null. */
export function exactUser(row, index) {
  const email = row.email || (row.name.includes('@') ? row.name.toLowerCase() : '');
  const name = row.name.toLowerCase();
  // A name with spaces is a person's display name: matched as a full name (only when unambiguous), never by
  // turning it into a username ("Sean Casey" is not necessarily sean.casey when there are two of them).
  const display = /\s/.test(name.trim());
  return (
    only(index.byEmail.get(email)) ??
    only(index.byUsername.get(name)) ??
    (display ? null : only(index.byNormalized.get(normalizeUsername(name)))) ??
    only(index.byFullName.get(name.replace(/\s+/g, ' ')))
  );
}

/** Suggestions for a row among `profiles`, never one in `rejected`: [{ id, label, score }] best first (≤ 5, ≥ 0.60). */
export function suggest(rowTokens, profiles, rejected = []) {
  const no = new Set(rejected);
  return profiles
    .filter((p) => !no.has(p.id))
    .map((p) => ({ id: p.id, label: p.label, score: Math.round(score(rowTokens, p.tokens) * 100) / 100 }))
    .filter((s) => s.score >= SUGGEST)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 5);
}

/** The decision for a subject: its own, else one taken on an alias (same normalised tokens). */
function decisionFor(decisions, aliases, dim, key, sig) {
  return decisions.get(`${dim}:${key}`) ?? (sig ? aliases.get(`${dim}:${sig}`) : null) ?? null;
}

/**
 * Attribute every row of the latest polls. `latest`: { dim: Map(key → row) }; `org`: users/projects/applications/
 * groups maps; `decisions`: Map(`${dim}:${key}` → decision). Returns { map: { dim: Map(key → entityId) }, rows: [queue
 * rows], aliasesAdded: [[decisionKey, subjectKey]] }.
 */
export function attribute(latest, org, decisions) {
  const aliases = new Map();
  for (const d of decisions.values()) if (d.sig) aliases.set(`${d.dimension}:${d.sig}`, d);
  const userIndex = indexUsers(org.users ?? new Map());
  const map = {};
  const rows = [];
  const aliasesAdded = [];
  for (const dim of ATTRIBUTED_DIMENSIONS) {
    const out = new Map();
    map[dim] = out;
    const entities = dim === 'user' ? org.users : dim === 'project' ? org.projects : dim === 'application' ? org.applications : org.groups;
    const byName = new Map();
    if (dim !== 'user') for (const e of entities?.values() ?? []) add(byName, String(e.name ?? '').toLowerCase(), e.id);
    const profiles = dim === 'user' ? userIndex.profiles : [...(entities?.values() ?? [])].map((e) => ({ id: e.id, label: e.path ?? e.name, tokens: tokens(e.path ?? e.name) }));
    for (const row of latest[dim]?.values() ?? []) {
      const sig = signature(row.email || row.name);
      const decision = decisionFor(decisions, aliases, dim, row.key, sig);
      if (decision && decision.key !== `${dim}:${row.key}` && !(decision.aliases ?? []).includes(row.key)) aliasesAdded.push([decision.key, row.key]);
      const rejected = decision?.rejected ?? [];
      let status;
      let entityId = null;
      let suggestions = [];
      let ghost = false;
      if (decision?.pinned) {
        if (entities?.has(decision.pinned) || !entities?.size) {
          status = 'pinned';
          entityId = decision.pinned;
        } else {
          status = 'disputed';
          ghost = true;
        }
      } else if (decision?.ignored) status = 'ignored';
      else if (dim === 'user' && isAutomation(row.name)) status = 'automation';
      else if (dim === 'user' && isBot(row.name || row.email)) status = 'bot';
      if (!status) {
        let exact = null;
        if (dim === 'user') exact = exactUser(row, userIndex);
        else if (row.id && entities?.has(row.id)) exact = row.id;
        else exact = only(byName.get(row.name.toLowerCase()));
        if (exact && !rejected.includes(exact)) {
          status = 'exact';
          entityId = exact;
        } else if (dim !== 'user' && byName.get(row.name.toLowerCase())?.size > 1) {
          status = 'disputed';
          suggestions = [...byName.get(row.name.toLowerCase())].filter((id) => !rejected.includes(id)).slice(0, 5).map((id) => ({ id, label: entities.get(id)?.path ?? entities.get(id)?.name ?? id, score: 1 }));
        } else {
          suggestions = suggest(tokens(row.email || row.name), profiles, rejected);
          const [top, next] = suggestions;
          // Two people with this very name: never merged, whatever the scores say (B23).
          const namesake = dim === 'user' && (userIndex.byFullName.get(row.name.toLowerCase().trim().replace(/\s+/g, ' '))?.size ?? 0) > 1;
          if (top && !namesake && top.score >= AUTO && !(next && top.score - next.score <= MARGIN)) {
            status = 'auto';
            entityId = top.id;
          } else status = top ? 'disputed' : 'unmatched';
        }
      }
      if (entityId && COUNTED.has(status)) out.set(row.key, entityId);
      rows.push({
        key: `${dim}:${row.key}`,
        dimension: dim,
        subjectKey: row.key,
        name: row.name,
        email: row.email,
        reportedId: row.id,
        credits: row.credits,
        status,
        entityId,
        suggestions,
        ghost,
        decision: decision ? { pinned: decision.pinned ?? null, ignored: Boolean(decision.ignored), rejected: decision.rejected ?? [], by: decision.by, at: decision.at, why: decision.why ?? '', alias: decision.key !== `${dim}:${row.key}` } : null,
      });
    }
  }
  return { map, rows, aliasesAdded };
}

/** The tab a queue row belongs in: one definition of "not counted" everywhere (B21). */
export function tabOf(row) {
  if (row.status === 'ignored') return 'ignored';
  if (row.status === 'disputed') return 'disputes';
  if (COUNTED.has(row.status)) return 'matched';
  return 'unmatched';
}

/**
 * Apply an admin's decision to `decisions` (a Map): 'pin' (entityId), 'reject' (entityId, or the current match),
 * 'ignore', 'clear'. Returns { before, after } for the audit log.
 */
export function decide(decisions, { key, action, entityId = null, why = '', currentMatch = null, name = '', email = '' }, { by, now = new Date() }) {
  const k = cleanId(key, { label: 'subject', max: 400 });
  const [dimension, ...rest] = k.split(':');
  if (!ATTRIBUTED_DIMENSIONS.includes(dimension) || !rest.length) throw fail(400, 'That is not a consumption subject.');
  const before = decisions.get(k) ?? null;
  const base = before ? { ...before, rejected: [...(before.rejected ?? [])] } : { key: k, dimension, subjectKey: rest.join(':'), sig: signature(email || name), pinned: null, ignored: false, rejected: [], aliases: [] };
  base.by = String(by ?? '').slice(0, 254);
  base.at = now.toISOString();
  base.why = cleanText(why, 512);
  if (action === 'pin') {
    base.pinned = cleanId(entityId, { label: 'entity id' });
    base.ignored = false;
    base.rejected = base.rejected.filter((id) => id !== base.pinned);
  } else if (action === 'reject') {
    const target = entityId ? cleanId(entityId, { label: 'entity id' }) : currentMatch;
    if (!target) throw fail(400, 'There is no match to reject.');
    if (!base.rejected.includes(target)) base.rejected.push(target);
    if (base.rejected.length > 50) base.rejected = base.rejected.slice(-50);
    if (base.pinned === target) base.pinned = null;
  } else if (action === 'ignore') {
    base.ignored = true;
    base.pinned = null;
  } else if (action === 'clear') {
    decisions.delete(k);
    return { before, after: null };
  } else throw fail(400, 'Pin, reject, ignore or clear.');
  decisions.set(k, base);
  return { before, after: base };
}
