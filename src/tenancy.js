/**
 * Several Checkmarx One tenants on one server (off until an Admin turns it on).
 *
 * Each tenant has its own state: its Checkmarx One connection, settings, credits, tracked
 * reports, audit log, automation and the rest, in its own folder (the first tenant, "default",
 * keeps the folder's existing files, so turning this on moves nothing). What runs for a request
 * or a background job runs inside one tenant's context (AsyncLocalStorage), and the server's
 * stores are reached through that context, so code written for one tenant serves each in turn.
 * Server-wide things (sign-ins, users, HTTPS, updates, backups) stay outside any tenant.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_TENANT = 'default';
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

export class Tenancy {
  #file;
  #dataDir;
  #build;
  #state;
  #contexts = new Map();
  #als = new AsyncLocalStorage();

  /**
   * @param {object} options
   * @param {string} options.dataDir  the server's state folder
   * @param {(tenant: {id, name, dir}) => object} options.build  makes a tenant's stores
   */
  constructor({ dataDir, build }) {
    this.#dataDir = dataDir;
    this.#file = path.join(dataDir, 'tenants.json');
    this.#build = build;
    this.#state = this.#load();
  }

  #load() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {}
    const tenants = Array.isArray(raw.tenants) ? raw.tenants.filter((t) => t && (ID.test(String(t.id ?? '')) || t.id === DEFAULT_TENANT)) : [];
    if (!tenants.some((t) => t.id === DEFAULT_TENANT)) tenants.unshift({ id: DEFAULT_TENANT, name: '', createdAt: '' });
    return { enabled: raw.enabled === true, enabledBy: raw.enabledBy ?? '', enabledAt: raw.enabledAt ?? '', tenants };
  }

  #save() {
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  get file() {
    return this.#file;
  }

  /** Is more than one tenant possible (the switch in Settings → Checkmarx One)? */
  get enabled() {
    return this.#state.enabled;
  }

  get status() {
    return { enabled: this.#state.enabled, enabledBy: this.#state.enabledBy, enabledAt: this.#state.enabledAt };
  }

  /** The folder a tenant's files live in: the state folder itself for the first one. */
  dirOf(id) {
    return id === DEFAULT_TENANT ? this.#dataDir : path.join(this.#dataDir, 'tenants', id);
  }

  list() {
    return this.#state.tenants.map((t) => ({ ...t }));
  }

  ids() {
    return this.#state.tenants.map((t) => t.id);
  }

  has(id) {
    return this.#state.tenants.some((t) => t.id === id);
  }

  get(id) {
    const tenant = this.#state.tenants.find((t) => t.id === id);
    return tenant ? { ...tenant } : null;
  }

  enable({ by }) {
    this.#state.enabled = true;
    this.#state.enabledBy = String(by ?? '');
    this.#state.enabledAt = new Date().toISOString();
    this.#save();
  }

  disable() {
    if (this.#state.tenants.length > 1) throw fail(409, 'Remove the other tenants first: only the first tenant may remain.');
    this.#state.enabled = false;
    this.#save();
  }

  /** Add a tenant: a short id made from its name, and an empty folder of its own. */
  add({ name, by = '' }) {
    if (!this.#state.enabled) throw fail(409, 'Turn on several tenants first (Settings → Checkmarx One).');
    const label = String(name ?? '').trim().slice(0, 80);
    if (!label) throw fail(400, 'Give the tenant a name.');
    if (this.#state.tenants.some((t) => t.name.toLowerCase() === label.toLowerCase())) throw fail(409, `There is already a tenant named "${label}".`);
    const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'tenant';
    let id = /^[a-z0-9]/.test(base) && base.length > 1 ? base : `t-${base}`;
    if (id === DEFAULT_TENANT || this.has(id)) id = `${id.slice(0, 30)}-${randomBytes(3).toString('hex')}`;
    const tenant = { id, name: label, createdAt: new Date().toISOString(), createdBy: String(by) };
    fs.mkdirSync(this.dirOf(id), { recursive: true, mode: 0o700 });
    this.#state.tenants.push(tenant);
    this.#save();
    return { ...tenant };
  }

  rename(id, name) {
    const tenant = this.#state.tenants.find((t) => t.id === id);
    if (!tenant) throw fail(404, 'No such tenant.');
    const label = String(name ?? '').trim().slice(0, 80);
    if (!label) throw fail(400, 'Give the tenant a name.');
    if (this.#state.tenants.some((t) => t !== tenant && t.name.toLowerCase() === label.toLowerCase())) throw fail(409, `There is already a tenant named "${label}".`);
    tenant.name = label;
    this.#save();
    return { ...tenant };
  }

  /** Remove a tenant from the list (its folder is kept, renamed, so nothing is lost). */
  remove(id) {
    if (id === DEFAULT_TENANT) throw fail(400, 'The first tenant cannot be removed.');
    const index = this.#state.tenants.findIndex((t) => t.id === id);
    if (index === -1) throw fail(404, 'No such tenant.');
    const [tenant] = this.#state.tenants.splice(index, 1);
    this.#save();
    this.#contexts.get(id)?.close?.();
    this.#contexts.delete(id);
    const dir = this.dirOf(id);
    try {
      fs.renameSync(dir, `${dir}.removed-${Date.now()}`);
    } catch {}
    return tenant;
  }

  /** A tenant's stores, made the first time they are needed. */
  context(id = DEFAULT_TENANT) {
    let context = this.#contexts.get(id);
    if (!context) {
      const tenant = this.get(id);
      if (!tenant) throw fail(404, 'No such tenant.');
      fs.mkdirSync(this.dirOf(id), { recursive: true, mode: 0o700 });
      context = { id, state: {}, ...this.#build({ ...tenant, dir: this.dirOf(id) }) };
      this.#contexts.set(id, context);
    }
    return context;
  }

  /** The tenant the running request or job belongs to; the first tenant outside any. */
  current() {
    return this.#als.getStore() ?? this.context(DEFAULT_TENANT);
  }

  /** Run `fn` inside tenant `id` (everything it starts, timers included, stays in it). */
  run(id, fn) {
    return this.#als.run(this.context(id), fn);
  }

  /** Run `fn` once for every tenant, each inside its own context. */
  each(fn) {
    return this.ids().map((id) => this.run(id, () => fn(id)));
  }

  /** The contexts made so far (for flushing on shutdown). */
  loaded() {
    return [...this.#contexts.values()];
  }
}

/**
 * A stand-in for one of a tenant's stores: every property and method is the current
 * tenant's (methods bound to the real object, so private fields work).
 */
export function scoped(tenancy, name) {
  if (name === 'state') return scopedState(tenancy);
  return new Proxy(Object.create(null), {
    get(_, prop) {
      const target = tenancy.current()[name];
      const value = target?.[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_, prop, value) {
      tenancy.current()[name][prop] = value;
      return true;
    },
    has(_, prop) {
      return prop in tenancy.current()[name];
    },
  });
}

/** The current tenant's own variables (its integration session and the like), read and written like plain fields. */
export function scopedState(tenancy) {
  return new Proxy(Object.create(null), {
    get: (_, prop) => tenancy.current().state[prop],
    set(_, prop, value) {
      tenancy.current().state[prop] = value;
      return true;
    },
  });
}
