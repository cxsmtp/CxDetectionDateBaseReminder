// The Cx Credits Calculator on its own: one HTML file (built by src/standalone-calculator.js) that runs in
// any browser with no server. It answers the calculator's requests (public/calculator/page.js) itself, with
// the same rules as the server (profiles.js), and keeps customers and reports in this browser (IndexedDB).
// It never reads Checkmarx One: the two exports from Checkmarx One → Analytics stand in.

import { initCalculator } from './page.js';
import { impactSettings } from './model.js';
import { MAX_PROFILES, MAX_REPORTS, fail, migrate, newProfile, newReport, patchProfile, reportMeta, summary } from './profiles.js';
import { startHelpTips } from '../help-tips.js';

const DB_NAME = 'cx-credits-calculator';
const NAMES_KEY = 'cxcalc-names';
const THEME_KEY = 'cxcalc-theme';

/** The browser's database: customers and reports, each by id. Falls back to memory when it cannot be opened. */
function openStore() {
  const memory = { customers: new Map(), reports: new Map() };
  const opened = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        for (const name of ['customers', 'reports']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  const tx = async (name, mode, fn) => {
    const db = await opened;
    if (!db) return fn(null, memory[name]);
    return new Promise((resolve, reject) => {
      const t = db.transaction(name, mode);
      const store = t.objectStore(name);
      let out;
      Promise.resolve(fn(store, null)).then((value) => (out = value), reject);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error ?? new Error('The browser could not save this.'));
      t.onabort = () => reject(t.error ?? new Error('The browser could not save this: it may be out of space.'));
    });
  };
  const ask = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return {
    persistent: opened.then(Boolean),
    all: (name) => tx(name, 'readonly', (store, mem) => (store ? ask(store.getAll()) : [...mem.values()])),
    get: (name, id) => tx(name, 'readonly', (store, mem) => (store ? ask(store.get(id)) : mem.get(id))),
    put: (name, value) => tx(name, 'readwrite', (store, mem) => (store ? ask(store.put(value)) : mem.set(value.id, value))),
    remove: (name, id) => tx(name, 'readwrite', (store, mem) => (store ? ask(store.delete(id)) : mem.delete(id))),
  };
}

const readNames = () => {
  try {
    const v = JSON.parse(localStorage.getItem(NAMES_KEY) || '{}');
    return { organisation: String(v.organisation ?? ''), preparedBy: String(v.preparedBy ?? '') };
  } catch {
    return { organisation: '', preparedBy: '' };
  }
};

/** The calculator's requests, answered here as the server answers them (src/server.js, /api/projections…). */
function localApi(store, names) {
  const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));
  const customer = async (id) => {
    const found = await store.get('customers', id);
    if (!found) throw fail(404, 'That customer no longer exists.');
    return migrate(found);
  };
  const routes = [
    ['GET', /^\/api\/projections$/, async () => {
      const all = (await store.all('customers')).map(migrate);
      return { customers: all.sort((a, b) => String(a.name).localeCompare(String(b.name))).map(summary), organisationName: names().organisation, impactDefaults: impactSettings({}) };
    }],
    ['POST', /^\/api\/projections$/, async (body) => {
      if ((await store.all('customers')).length >= MAX_PROFILES) throw fail(409, `There are already ${MAX_PROFILES} customers. Delete one first.`);
      const profile = newProfile({ name: body?.name, by: names().preparedBy });
      await store.put('customers', profile);
      return { customer: profile };
    }],
    ['GET', /^\/api\/projections\/reports$/, async (_body, _m, query) => {
      const id = query.get('customer') || '';
      const list = (await store.all('reports')).filter((r) => !id || r.customerId === id).sort(byNewest);
      return { reports: list.map(reportMeta) };
    }],
    ['POST', /^\/api\/projections\/reports$/, async (body) => {
      const c = await customer(String(body?.customerId ?? ''));
      const report = newReport({ customerId: c.id, customer: c.name, by: names().preparedBy, data: body?.data });
      await store.put('reports', report);
      for (const old of (await store.all('reports')).sort(byNewest).slice(MAX_REPORTS)) await store.remove('reports', old.id);
      return { report: reportMeta(report) };
    }],
    ['POST', /^\/api\/projections\/reports\/[^/]+\/email$/, async () => {
      throw fail(409, 'This calculator runs on its own and sends no email: download the report and attach it.');
    }],
    ['GET', /^\/api\/projections\/reports\/([^/]+)$/, async (_body, m) => {
      const report = await store.get('reports', decodeURIComponent(m[1]));
      if (!report) throw fail(404, 'That report no longer exists.');
      return { report };
    }],
    ['DELETE', /^\/api\/projections\/reports\/([^/]+)$/, async (_body, m) => {
      if (!(await store.get('reports', decodeURIComponent(m[1])))) throw fail(404, 'That report no longer exists.');
      await store.remove('reports', decodeURIComponent(m[1]));
      return { ok: true };
    }],
    ['GET', /^\/api\/projections\/read$/, async () => ({ state: 'none' })],
    ['POST', /^\/api\/projections\/(read|series)$/, async () => {
      throw fail(409, 'This calculator works from the two Checkmarx One exports: drop them below, or load the sample data.');
    }],
    ['GET', /^\/api\/projections\/([^/]+)$/, async (_body, m) => ({ customer: await customer(decodeURIComponent(m[1])) })],
    ['PUT', /^\/api\/projections\/([^/]+)$/, async (body, m) => {
      const patch = {};
      for (const key of ['name', 'tr', 'fusion', 'totals', 'scope', 'impact']) if (body?.[key] !== undefined) patch[key] = body[key];
      const next = patchProfile(await customer(decodeURIComponent(m[1])), patch, names().preparedBy);
      await store.put('customers', next);
      return { customer: summary(next) };
    }],
    ['DELETE', /^\/api\/projections\/([^/]+)$/, async (_body, m) => {
      await customer(decodeURIComponent(m[1]));
      await store.remove('customers', decodeURIComponent(m[1]));
      return { ok: true };
    }],
  ];
  return async (path, { method = 'GET', body } = {}) => {
    const url = new URL(path, 'https://calculator.invalid');
    for (const [verb, pattern, handle] of routes) {
      const m = verb === method && pattern.exec(url.pathname);
      if (m) return structuredClone(await handle(body ? JSON.parse(body) : null, m, url.searchParams));
    }
    throw fail(404, 'Not available in the standalone calculator.');
  };
}

export function startStandalone({ samples = {} } = {}) {
  const $ = (id) => document.getElementById(id);
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  let toastTimer = null;
  const toast = (message, kind = '', ms = 6000) => {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  };
  const setStatus = (id, message, kind = '') => {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.className = `status ${kind}`;
  };
  const showError = (id, error) => setStatus(id, error.message, 'error');
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

  // The theme: as the computer has it, or light or dark as chosen here.
  const applyTheme = (theme) => {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  };
  try {
    applyTheme(localStorage.getItem(THEME_KEY));
  } catch {}
  $('sa-theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
  });

  // The names on the reports: the organisation making them, and who prepared them.
  let names = readNames();
  $('sa-org').value = names.organisation;
  $('sa-by').value = names.preparedBy;
  const store = openStore();
  const calculator = initCalculator({
    api: localApi(store, () => names),
    $,
    esc,
    toast,
    setStatus,
    showError,
    handleAuthLoss: () => false,
    fmtDateTime,
    me: () => ({ organisationName: names.organisation, user: { name: names.preparedBy } }),
    can: () => true,
    standalone: true,
    sampleFile: async (name) => {
      const b64 = samples[name];
      if (!b64) throw new Error(`${name}: not in this file`);
      return new Response(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
    },
  });
  for (const id of ['sa-org', 'sa-by']) {
    $(id).addEventListener('input', () => {
      names = { organisation: $('sa-org').value.trim().slice(0, 120), preparedBy: $('sa-by').value.trim().slice(0, 120) };
      try {
        localStorage.setItem(NAMES_KEY, JSON.stringify(names));
      } catch {}
      calculator.renderOrg();
    });
  }

  // Everything kept here, as one file to keep or move to another browser; and back.
  $('sa-backup').addEventListener('click', async () => {
    const data = { kind: 'cx-credits-calculator', version: 1, savedAt: new Date().toISOString(), names, customers: await store.all('customers'), reports: await store.all('reports') };
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })), download: `cx-credits-calculator-backup-${data.savedAt.slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    toast(`Backed up ${data.customers.length} customer(s) and ${data.reports.length} report(s).`, 'ok');
  });
  $('sa-restore').addEventListener('click', () => $('sa-restore-file').click());
  $('sa-restore-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.kind !== 'cx-credits-calculator' || !Array.isArray(data.customers) || !Array.isArray(data.reports)) throw new Error('That is not a backup of this calculator.');
      if (!confirm(`Restore ${data.customers.length} customer(s) and ${data.reports.length} report(s)?\n\nThose with the same id are replaced; the others here stay.`)) return;
      for (const c of data.customers.slice(0, MAX_PROFILES)) if (c && typeof c.id === 'string') await store.put('customers', patchProfile(migrate(c), {}, c.updatedBy ?? ''));
      for (const r of data.reports.slice(0, MAX_REPORTS)) if (r && typeof r.id === 'string') await store.put('reports', { ...newReport({ customerId: r.customerId, customer: r.customer, by: r.createdBy, data: r.data }), id: r.id, createdAt: r.createdAt ?? new Date().toISOString() });
      await calculator.load();
      toast('Restored.', 'ok');
    } catch (error) {
      toast(error.message, 'bad', 9000);
    }
  });

  startHelpTips();
  store.persistent.then((ok) => {
    if (!ok) toast('This browser does not let this page keep data: customers and reports last until the page is closed. Use Back up to keep them.', 'warn', 12000);
  });
  calculator.load();
}
