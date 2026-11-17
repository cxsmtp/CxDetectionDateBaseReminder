/**
 * Primary branches, per tenant: the order protected branches are suggested in (an Admin's choice, else
 * src/protected-branches.js' DEFAULT_ORDER), and the last read of every project's branches (from Checkmarx
 * One and its git host) with the primary branch each suggests. Kept in branch-settings.json in the data
 * folder (per tenant) and in every backup.
 */

import { branchName } from './cxone/branches.js';
import { cleanOrder, DEFAULT_ORDER, suggestPrimary } from './protected-branches.js';
import { readState, writeState } from './state-file.js';

const text = (value, max) => String(value ?? '').slice(0, max);
const MAX_PROJECTS = 20_000;
const MAX_BRANCHES = 200;

/** One project as a read gives it, kept to what the page and the Workbench need. */
export function cleanProjectRead(p) {
  const list = (value) => (Array.isArray(value) ? [...new Set(value.map((n) => branchName(text(n, 200))).filter(Boolean))].slice(0, MAX_BRANCHES) : []);
  return {
    id: text(p?.id, 80),
    name: text(p?.name, 200),
    repoUrl: text(p?.repoUrl, 500),
    repo: text(p?.repo, 300),
    provider: ['github', 'gitlab', 'azure', 'bitbucket'].includes(p?.provider) ? p.provider : '',
    label: text(p?.label, 40),
    mainBranch: branchName(text(p?.mainBranch, 200)),
    protectedNames: list(p?.protectedNames),
    branches: list(p?.branches),
    error: text(p?.error, 300),
  };
}

export class BranchSettings {
  #file;
  #state;

  constructor({ file }) {
    this.#file = file;
    const raw = readState(file, { fallback: {}, holds: 'the order primary branches are suggested in, and the last read of every project\'s branches' }) ?? {};
    this.#state = {
      order: Array.isArray(raw.order) ? cleanOrder(raw.order) : null,
      orderAt: text(raw.orderAt, 40),
      orderBy: text(raw.orderBy, 200),
      read: raw.read && typeof raw.read === 'object' && Array.isArray(raw.read.projects)
        ? { at: text(raw.read.at, 40), by: text(raw.read.by, 200), projects: raw.read.projects.slice(0, MAX_PROJECTS).map(cleanProjectRead).filter((p) => p.id) }
        : null,
    };
  }

  /** The order in use: an Admin's, else the default. */
  get order() {
    return this.#state.order ?? [...DEFAULT_ORDER];
  }

  get orderChanged() {
    return Boolean(this.#state.order);
  }

  get orderInfo() {
    return { order: this.order, custom: this.orderChanged, at: this.#state.orderAt, by: this.#state.orderBy };
  }

  /** An Admin's order (null puts the default back). */
  setOrder(list, { by = '' } = {}) {
    this.#state.order = list === null ? null : cleanOrder(list);
    this.#state.orderAt = new Date().toISOString();
    this.#state.orderBy = text(by, 200);
  }

  get read() {
    return this.#state.read;
  }

  setRead(read) {
    this.#state.read = { at: text(read?.at, 40) || new Date().toISOString(), by: text(read?.by, 200), projects: (read?.projects ?? []).slice(0, MAX_PROJECTS).map(cleanProjectRead).filter((p) => p.id) };
  }

  /** A project's entry in the last read (null when it was not read). */
  project(id) {
    return this.#state.read?.projects.find((p) => p.id === String(id)) ?? null;
  }

  /** After a primary branch was written to Checkmarx One: the last read says so too. */
  noteMainBranch(id, branch) {
    const p = this.project(id);
    if (p) p.mainBranch = branchName(branch);
  }

  /** The primary branch each project suggests, by the order in use: {projectId: {branch, why}}. */
  suggestionFor(p, order = this.order) {
    return suggestPrimary({ branches: p.branches, protectedNames: p.protectedNames, order });
  }

  /** For the Workbench: a suggestion for each project with no primary branch set in Checkmarx One. */
  suggestions() {
    const out = Object.create(null);
    const order = this.order;
    for (const p of this.#state.read?.projects ?? []) {
      if (p.mainBranch) continue;
      const s = this.suggestionFor(p, order);
      if (s.branch) out[p.id] = s;
    }
    return out;
  }

  save() {
    writeState(this.#file, { version: 1, ...this.#state });
  }
}
