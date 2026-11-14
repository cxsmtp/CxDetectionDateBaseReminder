/**
 * Beta features, and making them final.
 *
 * A feature starts in Beta. Those in Labs (`labs: true`) are each behind two permissions on the role: Labs itself
 * (labs.view) and the item's own (labs.<id>); one behind an activation code also needs that code in force. SLAs,
 * in Settings rather than Labs, stay with "Beta features" (beta.use). An Admin (features.manage) makes a feature
 * final once it has proved itself; from then on it is for everyone holding the permission named here too, it
 * loses its Beta label, and what it adds elsewhere (scheduled reminders, the Workbench) turns on. Putting it back
 * in Beta undoes that.
 */

export const FEATURES = [
  {
    id: 'codeAuthors',
    labs: true,
    name: 'Code authors (git blame)',
    summary: 'Find the developer who last changed each vulnerable line, and email them the findings in their code.',
    // Once final: whoever may send reminders may use it, and scheduled reminders can include it.
    permission: 'reminders.send',
    whenFinal: [
      'Anyone who may send reminders can find and email code authors (no Labs permission needed).',
      'Scheduled reminders can also email the developer who last changed each vulnerable line (Act → Automation).',
      'The Workbench\'s Remind panel links straight to it.',
    ],
    // What to have seen before making it final.
    beforeFinal: 'Keep it in Beta until it has been right on your own repositories: run Find code authors on real findings and check that the "Sure" answers name the right developers. Unattended runs only ever email "Sure" answers.',
  },
  {
    id: 'sla',
    name: 'SLAs and escalation',
    summary: 'Days to fix each severity, counted from first detection: what is overdue or due soon on the Workbench, and one escalation email per finding that goes past its SLA.',
    // Once final: everyone who can see findings sees the SLA figures.
    permission: 'findings.fetch',
    whenFinal: [
      'Everyone who loads findings sees what is overdue and due soon, on the Workbench and in each project (no Beta permission needed).',
      'Escalation stays as set under Settings → SLAs: off until an Admin names who to escalate to.',
    ],
    beforeFinal: 'Keep it in Beta until the due days match your policy and the overdue counts look right on your own findings.',
  },
  {
    id: 'identityMatching',
    labs: true,
    name: 'Match usernames to email addresses',
    summary: 'Turn the usernames of scan initiators on GitHub, GitLab, Azure DevOps or Bitbucket into email addresses.',
    permission: 'settings.initiators',
    whenFinal: ['Anyone who may change initiator addresses can run and apply the matching (no Labs permission needed).'],
  },
  {
    id: 'fusionResults',
    labs: true,
    name: 'Fusion results',
    summary: 'What Checkmarx One Fusion re-scored in the projects you load: critical, high, medium and low per project, the risk it raised to critical or high, and results per credit.',
    // Once final: everyone who can see findings sees the Fusion page and column.
    permission: 'findings.fetch',
    whenFinal: [
      'Everyone who loads findings sees the Fusion page, read again with each Workbench fetch (no Labs permission needed).',
      'The Workbench\'s projects table can show each project\'s Fusion results (the Fusion column).',
    ],
    beforeFinal: 'Keep it in Beta until the counts match what Checkmarx One shows for Fusion on your own applications.',
  },
  {
    id: 'faeFlush',
    labs: true,
    // Once final it leaves Labs (FAE Flush to Act, Govern to its own group).
    leavesLabsWhenFinal: true,
    name: 'FAE Flush',
    // Not for everyone: only once an activation code from the maintainer has unlocked it (feature:faeFlush).
    unlockedBy: 'faeFlush',
    summary: 'Findings Analysis (FAE) on the backlog, for the whole tenant at once: each project\'s code scanned again on a "<name>_FAE" copy with FAE on, and the results it no longer reports marked Proposed not exploitable in the original project, which keeps its history, triage and automations.',
    // Once final: whoever manages the Checkmarx One integration (it creates, scans and deletes projects with its key).
    permission: 'integration.cxone',
    whenFinal: [
      'It moves out of Labs to the top of Act (FAE Flush, Workbench, Automation); the Workbench stays the home page.',
      'Anyone who manages the Checkmarx One integration can run it (no Labs permission needed).',
    ],
    beforeFinal: 'Keep it in Beta until a run on a few of your own projects has marked what you expected: check some of the results it marked in Checkmarx One, and that Undo puts them back.',
  },
  {
    id: 'govern',
    labs: true,
    // Once final it leaves Labs (FAE Flush to Act, Govern to its own group).
    leavesLabsWhenFinal: true,
    name: 'Govern',
    // Not for everyone: only once an activation code from the maintainer has unlocked it (feature:govern).
    unlockedBy: 'govern',
    summary: 'Credit governance for the whole tenant: budgets on users, groups, projects and applications, what Checkmarx One reports each of them used, alerts near and over a budget, credit requests, and — only for budgets an Admin or Security Champion set to Enforce — reversible restrictions in Checkmarx One.',
    // Once final: whoever may see Govern.
    permission: 'govern.view',
    // Once final, for whoever holds one of Govern's own permissions (in Labs: Labs: Govern; what they may do there still follows them).
    usableWith: ['govern.view', 'govern.request'],
    whenFinal: [
      'It moves out of Labs to its own menu group, Govern, between Prove and Plan.',
      'Everyone holding a Govern permission uses it (no Labs permission needed).',
    ],
    beforeFinal: 'Keep it in Beta (budgets in Monitor) until the figures match what Checkmarx One shows for your own users and projects, and the Attribution queue is settled; then switch a first budget to Enforce and check that Restore puts everything back.',
  },
  {
    id: 'statusBoard',
    labs: true,
    name: 'Status board',
    // Not for everyone: only once an activation code from the maintainer has unlocked it (feature:statusBoard).
    unlockedBy: 'statusBoard',
    summary: 'Every project\u2019s last scan and its results at a glance, from the data the Workbench loaded: open results by severity in one bar per project, or how long ago each was scanned, which engines ran and which scans failed.',
    // Once final: whoever may load findings.
    permission: 'findings.fetch',
    usableWith: ['findings.fetch'],
    whenFinal: ['It loses its Beta label; everyone who loads findings sees it (no Labs permission needed).'],
    beforeFinal: 'Keep it in Beta until the last scans, engines and failed scans it shows match Checkmarx One for your own projects.',
  },
  {
    id: 'consolidated',
    labs: true,
    name: 'Consolidated view',
    // Not for everyone: only once an activation code from the maintainer has unlocked it (feature:consolidated).
    unlockedBy: 'consolidated',
    summary: 'Every connected tenant in one place, read only: projects, open results, overdue, credits, Fusion and the status board of each tenant, with every visit written to that tenant\u2019s audit log.',
    // Only for the people an Admin ticked (People & roles), in Labs with Labs: Consolidated view on their role too.
    permission: 'consolidated.view',
    onlyWith: 'consolidated.view',
    usableWith: ['consolidated.view'],
    whenFinal: ['It loses its Beta label; still only for the people an Admin ticked.'],
    beforeFinal: 'Keep it in Beta until every tenant\u2019s figures match what that tenant shows when you open it.',
  },
];

const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));
export const STAGES = ['beta', 'final'];

export const featureById = (id) => BY_ID.get(String(id)) ?? null;

/** 'beta' or 'final'. */
export const stageOf = (settings, id) => (settings?.features?.[id]?.stage === 'final' ? 'final' : 'beta');
export const isFinal = (settings, id) => stageOf(settings, id) === 'final';

/** Stored features, cleaned: only known ids, stage 'beta' or 'final', who and when. */
export function mergeFeatures(current = {}, incoming = null) {
  const next = {};
  for (const feature of FEATURES) {
    const entry = current?.[feature.id];
    if (entry && STAGES.includes(entry.stage)) next[feature.id] = { stage: entry.stage, at: String(entry.at ?? ''), by: String(entry.by ?? '') };
  }
  for (const [id, entry] of Object.entries(incoming ?? {})) {
    if (!BY_ID.has(id) || !entry || !STAGES.includes(entry.stage)) continue;
    next[id] = { stage: entry.stage, at: String(entry.at ?? new Date().toISOString()), by: String(entry.by ?? '').slice(0, 254) };
  }
  return next;
}

/** Every feature with its stage, for the page. */
export function featureList(settings) {
  return FEATURES.map((f) => ({ ...f, stage: stageOf(settings, f.id), changedAt: settings?.features?.[f.id]?.at ?? '', changedBy: settings?.features?.[f.id]?.by ?? '' }));
}

/** The permission that shows Labs in the menu, and each Labs item's own (labs.<id>). */
export const LABS_VIEW = 'labs.view';
export const labsPermission = (id) => `labs.${id}`;
export const LABS_FEATURES = FEATURES.filter((f) => f.labs).map((f) => f.id);

/** Is the feature in Labs now? Every Labs item while in Beta; once final, all but those that move out (FAE Flush, Govern). */
export function inLabs(settings, id) {
  const feature = featureById(id);
  return Boolean(feature?.labs) && !(feature.leavesLabsWhenFinal && isFinal(settings, id));
}

/**
 * May someone holding `permissions` use the feature?
 * In Labs: with Labs and the item's own permission, both on their role. Once final: also with the feature's own
 * permission or, for a feature that names permissions it is usable with (`usableWith`), any of those.
 * SLAs (not in Labs): with Beta features while in Beta, then with its own permission.
 */
export function mayUse(settings, id, permissions) {
  const feature = featureById(id);
  if (!feature) return false;
  // A feature only for the people given its own grant (the consolidated view): nothing else is enough.
  if (feature.onlyWith && !permissions?.has(feature.onlyWith)) return false;
  if (feature.labs ? permissions?.has(LABS_VIEW) && permissions?.has(labsPermission(id)) : permissions?.has('beta.use')) return true;
  if (!isFinal(settings, id)) return false;
  return Boolean(permissions?.has(feature.permission) || feature.usableWith?.some((p) => permissions?.has(p)));
}
