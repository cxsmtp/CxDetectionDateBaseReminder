/**
 * Govern (beta): the in-memory usage index every evaluation and every page reads (SPEC §4.6 step 2, §8.2).
 *
 * Built after a cycle's read phase (and again after an attribution decision, which needs no Checkmarx One call),
 * then swapped in as one reference: readers always see one consistent index, never half of the next one. Nothing
 * here reads a file or calls Checkmarx One. The increment arrays it holds are never changed afterwards (the series
 * replaces them on write).
 */
import { DIMENSIONS, sumIncrements } from './ingest.js';

const EMPTY = new Map();

export class UsageIndex {
  /**
   * @param {object} p
   * @param {number} p.at          when it was built (ms)
   * @param {object} p.series      { dim: UsageSeries }
   * @param {object} p.org         { users, groups, projects, applications } (Maps by id), readAt
   * @param {object} p.attribution { dim: Map(subjectKey → entityId) }
   * @param {object} p.dims        { dim: { supported, stale, lastAt, error, note } }
   * @param {object} [p.credits]   the tenant's /credits/info, or null
   */
  constructor({ at = Date.now(), series = {}, org = {}, attribution = {}, dims = {}, credits = null, queue = [] }) {
    this.at = at;
    this.org = { users: org.users ?? EMPTY, groups: org.groups ?? EMPTY, projects: org.projects ?? EMPTY, applications: org.applications ?? EMPTY, readAt: org.readAt ?? null };
    this.credits = credits;
    this.queue = queue;
    this.dims = {};
    this.#byEntity = {};
    this.#reported = {};
    for (const dim of DIMENSIONS) {
      const s = series[dim];
      const state = dims[dim] ?? {};
      this.dims[dim] = {
        supported: state.supported ?? null,
        stale: Boolean(state.stale),
        lastAt: s?.lastAt || 0,
        window: s?.window || '',
        seedAt: s?.seedAt || 0,
        error: state.error ?? '',
        note: state.note ?? '',
      };
      const byEntity = new Map();
      const reported = new Map();
      const map = attribution[dim];
      if (s) {
        for (const [key, list] of s.increments) {
          const entityId = dim === 'action' ? key : map?.get(key);
          if (!entityId) continue;
          if (!byEntity.has(entityId)) byEntity.set(entityId, []);
          byEntity.get(entityId).push(list);
        }
        for (const [key, row] of s.latest) {
          const entityId = dim === 'action' ? key : map?.get(key);
          if (entityId) reported.set(entityId, (reported.get(entityId) ?? 0) + row.credits);
        }
      }
      this.#byEntity[dim] = byEntity;
      this.#reported[dim] = reported;
      this.dims[dim].rows = s ? [...s.latest.values()] : [];
    }
    // Relations, once.
    this.#groupProjects = new Map();
    for (const p of this.org.projects.values()) for (const g of p.groups ?? []) (this.#groupProjects.get(g) ?? this.#groupProjects.set(g, new Set()).get(g)).add(p.id);
    this.#groupMembers = new Map();
    const byPath = new Map();
    const byName = new Map();
    for (const g of this.org.groups.values()) {
      byPath.set(g.path, g.id);
      byName.set(g.name, byName.has(g.name) ? null : g.id);
    }
    for (const u of this.org.users.values()) {
      for (const name of u.groups ?? []) {
        // Users name their groups; a duplicate name is ambiguous and not joined (B23), a path always is.
        const gid = name.startsWith('/') ? byPath.get(name) : byName.get(name);
        if (gid) (this.#groupMembers.get(gid) ?? this.#groupMembers.set(gid, new Set()).get(gid)).add(u.id);
      }
    }
  }

  #byEntity;
  #reported;
  #groupProjects;
  #groupMembers;

  /** A dimension is available when Checkmarx One reports it and at least one complete poll was accepted. */
  available(dim) {
    const d = this.dims[dim];
    return Boolean(d && d.supported !== false && d.lastAt > 0);
  }

  /** The group and, with `sub`, every group under it (by path). */
  groupAndBelow(groupId, sub) {
    const ids = new Set([groupId]);
    if (!sub) return ids;
    const root = this.org.groups.get(groupId);
    if (!root) return ids;
    for (const g of this.org.groups.values()) if (g.path.startsWith(`${root.path}/`)) ids.add(g.id);
    return ids;
  }

  projectsOf(entityType, entityId, { includeSubgroups = false } = {}) {
    if (entityType === 'project') return this.org.projects.has(entityId) ? [entityId] : [];
    if (entityType === 'application') return [...(this.org.applications.get(entityId)?.projectIds ?? [])];
    if (entityType === 'group') {
      const out = new Set();
      for (const g of this.groupAndBelow(entityId, includeSubgroups)) for (const p of this.#groupProjects.get(g) ?? []) out.add(p);
      return [...out];
    }
    return [];
  }

  membersOf(groupId, { includeSubgroups = false } = {}) {
    const out = new Set();
    for (const g of this.groupAndBelow(groupId, includeSubgroups)) for (const u of this.#groupMembers.get(g) ?? []) out.add(u);
    return [...out];
  }

  /** One entity's usage in one dimension over (from, to]. */
  #sum(dim, entityId, from, to) {
    let used = 0;
    let estimated = false;
    for (const list of this.#byEntity[dim].get(entityId) ?? []) {
      const r = sumIncrements(list, from, to);
      used += r.sum;
      estimated ||= r.estimated;
    }
    return { used, estimated, reported: this.#reported[dim].get(entityId) ?? 0 };
  }

  /**
   * An entity's usage over (from, to]: { available, stale, used, estimated, reported, source }. Applications and
   * groups Checkmarx One does not report directly are the sum of their projects (and, for a group with
   * `includeMembers`, its members' own usage too). Unavailable is never 0.
   */
  usage(entityType, entityId, { from = -Infinity, to = Infinity, includeMembers = false, includeSubgroups = false } = {}) {
    const direct = { user: 'user', project: 'project', application: 'application', group: 'group' }[entityType];
    const viaProjects = () => {
      if (!this.available('project')) return null;
      let used = 0;
      let reported = 0;
      let estimated = false;
      for (const pid of this.projectsOf(entityType, entityId, { includeSubgroups })) {
        const r = this.#sum('project', pid, from, to);
        used += r.used;
        reported += r.reported;
        estimated ||= r.estimated;
      }
      return { used, reported, estimated, stale: this.dims.project.stale, source: 'projects' };
    };
    let r = null;
    if (entityType === 'user') r = this.available('user') ? { ...this.#sum('user', entityId, from, to), stale: this.dims.user.stale, source: 'user' } : null;
    else if (entityType === 'project') r = this.available('project') ? { ...this.#sum('project', entityId, from, to), stale: this.dims.project.stale, source: 'project' } : null;
    else if (entityType === 'group' && includeMembers) {
      r = viaProjects();
      if (r && this.available('user')) {
        for (const uid of this.membersOf(entityId, { includeSubgroups })) {
          const u = this.#sum('user', uid, from, to);
          r.used += u.used;
          r.reported += u.reported;
          r.estimated ||= u.estimated;
        }
        r.stale ||= this.dims.user.stale;
        r.source = 'projects+members';
      } else r = null;
    } else if (direct && this.available(direct) && !(entityType === 'group' && includeSubgroups)) r = { ...this.#sum(direct, entityId, from, to), stale: this.dims[direct].stale, source: direct };
    else r = viaProjects();
    if (!r) return { available: false, stale: false, used: 0, reported: 0, estimated: false, source: 'none' };
    return { available: true, stale: r.stale, used: Math.round(r.used * 10000) / 10000, reported: Math.round(r.reported * 10000) / 10000, estimated: r.estimated, source: r.source };
  }

  /** The tenant's consumption in the window by action type (the action dimension), or null. */
  byAction() {
    if (!this.available('action')) return null;
    return this.dims.action.rows.map((r) => ({ action: r.name, credits: r.credits, transactions: r.transactions })).sort((a, b) => b.credits - a.credits);
  }

  /** Top consumers of one level in the window (what Checkmarx One reports), attributed: [{ entityId, credits }]. */
  top(dim, n = 10) {
    return [...this.#reported[dim].entries()].map(([entityId, credits]) => ({ entityId, credits })).sort((a, b) => b.credits - a.credits).slice(0, n);
  }

  /** Increments of every subject of an entity (for "Diagnose a figure"). */
  subjectsOf(dim, entityId) {
    return this.#byEntity[dim]?.get(entityId)?.length ?? 0;
  }
}

/** Holds the current index; readers take `current`, the cycle swaps in the next. */
export class IndexHolder {
  current = new UsageIndex({});
  swap(next) {
    this.current = next;
    return next;
  }
}
