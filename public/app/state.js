// What the page knows: who is signed in and what they may do, the loaded scan, the page open. Every module shares it.

export const $ = (id) => document.getElementById(id);

export const state = {
  // The vulnerability search the data was loaded with ('' for every finding).
  vulnerability: '',
  connection: null,
  settings: null,
  health: null,
  projects: [],
  // True while a fetch is streaming in: triage, remediation and allocation wait.
  fetching: false,
  selected: new Set(),
  sort: { key: '60+', dir: 'desc' },
  // Set once the operator opens a fully-resolved list on purpose.
  showAllInitiators: false,
  automation: null,
  initiators: [],
  pickedInitiators: new Set(),
  lastScan: null,
  logs: [],
};

// ---------------------------------------------------------------------------
// Who is signed in, and what they may do
// ---------------------------------------------------------------------------

export const can = (permission) => Boolean(state.me?.permissions?.includes(permission));
export const canAny = (list) => String(list).split(/\s+/).filter(Boolean).some(can);
