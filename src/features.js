/**
 * Beta features, and making them final.
 *
 * A feature starts in Beta: on the Beta page, for people holding "Beta
 * features" (beta.use). An Admin (features.manage) makes it final once it has
 * proved itself; from then on it is for everyone holding the permission named
 * here too, it loses its Beta label, and what it adds elsewhere (scheduled
 * reminders, the Dashboard) turns on. Putting it back in Beta undoes that.
 */

export const FEATURES = [
  {
    id: 'codeAuthors',
    name: 'Code authors (git blame)',
    summary: 'Find the developer who last changed each vulnerable line, and email them the findings in their code.',
    // Once final: whoever may send reminders may use it, and scheduled reminders can include it.
    permission: 'reminders.send',
    whenFinal: [
      'Anyone who may send reminders can find and email code authors (no Beta permission needed).',
      'Scheduled reminders can also email the developer who last changed each vulnerable line (Settings → Automation).',
      'The Dashboard\'s Remind panel links straight to it.',
    ],
    // What to have seen before making it final.
    beforeFinal: 'Keep it in Beta until it has been right on your own repositories: run Find code authors on real findings and check that the "Sure" answers name the right developers. Unattended runs only ever email "Sure" answers.',
  },
  {
    id: 'sla',
    name: 'SLAs and escalation',
    summary: 'Days to fix each severity, counted from first detection: what is overdue or due soon on the Dashboard, and one escalation email per finding that goes past its SLA.',
    // Once final: everyone who can see findings sees the SLA figures.
    permission: 'findings.fetch',
    whenFinal: [
      'Everyone who loads findings sees what is overdue and due soon, on the Dashboard and in each project (no Beta permission needed).',
      'Escalation stays as set under Settings → SLAs: off until an Admin names who to escalate to.',
    ],
    beforeFinal: 'Keep it in Beta until the due days match your policy and the overdue counts look right on your own findings.',
  },
  {
    id: 'identityMatching',
    name: 'Match usernames to email addresses',
    summary: 'Turn the usernames of scan initiators on GitHub, GitLab, Azure DevOps or Bitbucket into email addresses.',
    permission: 'settings.initiators',
    whenFinal: ['Anyone who may change initiator addresses can run and apply the matching (no Beta permission needed).'],
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

/**
 * May someone holding `permissions` use the feature? Always with Beta access;
 * once final, also with the feature's own permission.
 */
export function mayUse(settings, id, permissions) {
  if (permissions?.has('beta.use')) return true;
  const feature = featureById(id);
  return Boolean(feature && isFinal(settings, id) && permissions?.has(feature.permission));
}
