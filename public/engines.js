/**
 * The Checkmarx One engines a finding can come from, and the choice of which of them to work on.
 * Shared by the server (src/engines.js) and the pages (the Dashboard, Credit Control, Settings and
 * the Cx Credits Calculator), so both always mean the same engines.
 *
 * Checkmarx One AI Triage and AI Remediation act on SAST and SCA findings only, so those two are
 * chosen unless someone picks otherwise: the Dashboard, its reports and reminders, tracked reports,
 * scheduled runs, Credit Control and the Cx Credits Calculator all follow the same choice. The
 * other engines can be added, and are marked as having no AI.
 *
 * A choice is a list of engine keys. An empty list, or one naming every engine, means no filter
 * (and then a finding from an engine not listed here is kept too).
 */

export const ENGINES = [
  { key: 'SAST', label: 'SAST', name: 'Code', ai: true },
  { key: 'SCA', label: 'SCA', name: 'Open-source packages', ai: true },
  { key: 'KICS', label: 'IaC', name: 'Infrastructure as code', ai: false },
  { key: 'CONTAINERS', label: 'Containers', name: 'Container images', ai: false },
  { key: 'APISEC', label: 'API Security', name: 'APIs', ai: false },
  { key: 'SECRETS', label: 'Secrets', name: 'Secrets in code', ai: false },
];
export const ENGINE_KEYS = ENGINES.map((e) => e.key);
/** What is chosen unless someone picks otherwise: the engines AI Triage and AI Remediation work on. */
export const DEFAULT_ENGINES = ENGINES.filter((e) => e.ai).map((e) => e.key);

// The names Checkmarx One uses for each engine, in findings, scan summaries and exports.
const ALIASES = new Map(
  Object.entries({
    SAST: 'SAST',
    SCA: 'SCA',
    KICS: 'KICS',
    IAC: 'KICS',
    'IAC-SECURITY': 'KICS',
    INFRASTRUCTURE: 'KICS',
    CONTAINERS: 'CONTAINERS',
    CONTAINER: 'CONTAINERS',
    'CONTAINER-SECURITY': 'CONTAINERS',
    SCACONTAINERS: 'CONTAINERS',
    APISEC: 'APISEC',
    'API-SECURITY': 'APISEC',
    APISECURITY: 'APISEC',
    SECRETS: 'SECRETS',
    'SECRET-DETECTION': 'SECRETS',
    SECRETDETECTION: 'SECRETS',
  }),
);

/** The engine key of a finding's scanner name ("sast", "IaC", "secret-detection"…), or the name upper-cased. */
export function engineOf(scanner) {
  const name = String(scanner ?? '').trim().toUpperCase().replace(/[\s_]+/g, '-');
  return ALIASES.get(name) ?? ALIASES.get(name.replace(/-/g, '')) ?? name;
}

/** A choice from a request or a setting (a list, or "SAST, SCA"): known engines only, in the usual order. */
export function cleanEngines(value) {
  const given = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  const wanted = new Set(given.map(engineOf));
  return ENGINE_KEYS.filter((key) => wanted.has(key));
}

/** null when the choice keeps every finding (none chosen, or all of them), else the chosen keys. */
export function engineScope(value) {
  const chosen = cleanEngines(value);
  return chosen.length && chosen.length < ENGINE_KEYS.length ? chosen : null;
}

/** Does this finding come from one of the chosen engines? (No choice keeps everything.) */
export function inEngines(risk, engines) {
  const scope = engineScope(engines);
  return !scope || scope.includes(engineOf(risk?.scanner));
}

/** "SAST, SCA" for a choice, "all engines" for none. */
export function describeEngines(engines) {
  const scope = engineScope(engines);
  return scope ? scope.map((key) => ENGINES.find((e) => e.key === key).label).join(', ') : 'all engines';
}
