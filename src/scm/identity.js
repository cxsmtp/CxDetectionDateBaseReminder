/**
 * Shared pieces for matching usernames to email addresses on any source-code host:
 * a directory matcher (exact usernames, then name forms like "jdoe" for "Jane Doe"),
 * and the side-by-side comparison of methods on coverage, requests and time, with a
 * recommendation from the numbers. Each host (src/scm/gitlab.js, azure.js, bitbucket.js)
 * supplies its own methods; GitHub keeps its own (src/github/identity.js).
 */

import { handle, nameHandles, stripAffixes, usableEmail } from '../github/identity.js';

const RANK = { high: 3, medium: 2, low: 1 };

/** Usernames as each host allows them. */
export const USERNAME_RE = {
  github: /^[a-z\d](?:[a-z\d-]{0,38})$/i,
  gitlab: /^[\w][\w.-]{0,254}$/,
  azure: /^[\w][\w .@'+-]{0,127}$/,
  bitbucket: /^[\w{][\w .@'+{}:-]{0,127}$/, // nicknames, display names, account ids (557058:…) and {uuid}s
};
export const validUsername = (provider, value) => (USERNAME_RE[provider] ?? USERNAME_RE.gitlab).test(String(value ?? '').trim());

/**
 * Index directory entries ({keys: [usernames…], name, email, evidence}) so a login is found
 * by an exact key first (high confidence), else by a form of the person's name (medium).
 * Keys or names shared by different addresses are left out: never guess between people.
 */
export function directoryMatcher(entries) {
  const exact = new Map();
  const byName = new Map();
  const put = (map, key, entry) => {
    if (!key) return;
    const known = map.get(key);
    if (known && known.email !== entry.email) known.ambiguous = true;
    else if (!known) map.set(key, { ...entry });
  };
  for (const entry of entries) {
    if (!usableEmail(entry.email)) continue;
    const e = { ...entry, email: entry.email.toLowerCase() };
    for (const key of entry.keys ?? []) put(exact, String(key).trim().toLowerCase(), e);
    for (const form of nameHandles(entry.name)) put(byName, form, e);
    put(byName, handle(e.email.split('@')[0].replace(/\+.*$/, '')), e);
  }
  for (const map of [exact, byName]) for (const [key, value] of map) if (value.ambiguous) map.delete(key);
  return (login) => {
    const value = String(login ?? '').trim().toLowerCase();
    const hit = exact.get(value) ?? exact.get(value.split('@')[0]);
    if (hit) return { email: hit.email, confidence: 'high', evidence: hit.evidence, name: hit.name ?? '' };
    const key = handle(value.split('@')[0]);
    const near = byName.get(key) ?? byName.get(handle(stripAffixes(value))) ?? (/\d$/.test(key) ? byName.get(key.replace(/\d+$/, '')) : undefined);
    return near ? { email: near.email, confidence: 'medium', evidence: `${near.evidence} (the username matches their name or address)`, name: near.name ?? '' } : null;
  };
}

/** Logins that are already addresses resolve to themselves. */
export function addressesAsThemselves(logins) {
  const results = {};
  for (const login of logins) if (usableEmail(login)) results[login] = { email: login.toLowerCase(), confidence: 'high', evidence: 'The username is an email address' };
  return results;
}

/**
 * Run `methods` ([{id, label, run(pending) → {results, errors}}], cheapest first) side by
 * side on the same logins, and compare them: coverage, requests and time per method, the
 * best address per login, and a recommendation.
 */
export async function evaluateMethods({ methods, logins, client = null, chosen = null }) {
  const report = { logins, methods: {}, combined: {}, recommendation: [] };
  const labels = Object.fromEntries(methods.map((m) => [m.id, m.label]));
  for (const method of methods) {
    if (chosen && !chosen.includes(method.id)) continue;
    if (method.skip) {
      report.methods[method.id] = { skipped: method.skip };
      continue;
    }
    const before = client?.totalRequests ?? 0;
    const started = Date.now();
    let outcome;
    try {
      outcome = await method.run(logins);
    } catch (error) {
      outcome = { results: {}, errors: [error.message] };
    }
    const requests = (client?.totalRequests ?? 0) - before;
    const resolved = Object.keys(outcome.results).length;
    report.methods[method.id] = {
      resolved,
      coverage: logins.length ? Math.round((resolved / logins.length) * 100) : 0,
      requests,
      ms: Date.now() - started,
      requestsPerMatch: resolved ? +(requests / resolved).toFixed(2) : null,
      errors: outcome.errors?.slice(0, 5) ?? [],
      limited: Boolean(outcome.limited),
      results: outcome.results,
    };
    for (const [login, found] of Object.entries(outcome.results)) {
      const current = report.combined[login];
      if (!current || RANK[found.confidence] > RANK[current.confidence]) report.combined[login] = { ...found, method: method.id };
      else if (current.email === found.email) current.agreedBy = [...(current.agreedBy ?? []), method.id];
    }
  }
  report.labels = labels;
  report.resolved = Object.keys(report.combined).length;
  report.recommendation = recommendFrom(report, labels);
  return report;
}

export function recommendFrom(report, labels) {
  const ran = Object.entries(report.methods).filter(([, m]) => !m.skipped);
  if (!ran.length) return ['Run at least one method to get a recommendation (some need the host connection set below).'];
  const ranked = [...ran].sort((a, b) => b[1].coverage - a[1].coverage || a[1].requests - b[1].requests);
  const [topId, top] = ranked[0];
  const lines = [`${labels[topId]} found the most: ${top.resolved} of ${report.logins.length} (${top.coverage}%) for ${top.requests} request(s).`];
  const cheap = ran.filter(([, m]) => m.resolved && (m.requests === 0 || m.requestsPerMatch <= 0.1));
  if (cheap.length) lines.push(`Cheapest per match: ${cheap.map(([id, m]) => `${labels[id]} (${m.requests} request(s))`).join(', ')}. Run these first.`);
  if (report.resolved > top.resolved) lines.push(`Combined, the methods found ${report.resolved} (${Math.round((report.resolved / Math.max(1, report.logins.length)) * 100)}%): run them in order of cost and stop at the first match.`);
  const limited = ran.filter(([, m]) => m.limited);
  if (limited.length) lines.push(`${limited.map(([id]) => labels[id]).join(', ')} hit the host's rate limit: keep it for the leftovers only.`);
  return lines;
}

/** Cheapest method first; each one only sees the logins still unresolved. {login: {email, confidence, evidence, method}}. */
export async function resolveWith(methods, logins) {
  let pending = [...new Set(logins)];
  const found = {};
  for (const method of methods) {
    if (!pending.length) break;
    if (method.skip) continue;
    let outcome = null;
    try {
      outcome = await method.run(pending);
    } catch {
      outcome = null;
    }
    for (const [login, result] of Object.entries(outcome?.results ?? {})) found[login] = { ...result, method: method.id };
    pending = pending.filter((login) => !found[login]);
  }
  return found;
}
