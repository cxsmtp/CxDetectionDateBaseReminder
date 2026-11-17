/**
 * The rules every spend of AI credits follows, wherever it is asked for: from an emailed report (the relay, where
 * nobody has signed in) or from the dashboard. No routes are registered here; src/routes/relay.js,
 * src/routes/credits.js and src/routes/tracked-reports.js are handed these.
 *
 * - What a report's request must be: its findings carrying valid grants, of a sane size, the action switched on;
 *   and how many refused requests are listed in the audit log before the rest are only counted.
 * - What is left to spend: a project's allocation, the pool for the period, and the tenant's own credits in
 *   Checkmarx One as last read (tenantCreditsOf, creditPool).
 * - The audit entry of every credit decision, allocation and settings change.
 */
import { CREDIT_COST } from '../credits.js';
import { creditFigures, billingUnit } from '../credit-allocations.js';
import { poolSummary } from '../credit-usage.js';
import { createHash } from 'node:crypto';
import { tenantCredits } from '../fusion-usage.js';
import { journeyOf } from '../journey.js';
import { SYSTEM_ACTOR, clientIp } from './shared.js';

/**
 * A project's credits as the dashboard shows them.
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function createCreditView(d) {
  const { creditLedger, allocations, SEVERITIES } = d;

  /**
   * Per-project credits for the dashboard: what is allocated and used, and what
   * the findings need (never allocated until someone confirms it).
   */
  function creditView(summary) {
    const risks = summary.risks ?? [];
    const figures = creditFigures(risks, { triaged: creditLedger.triagedAt(summary.projectId), remediated: creditLedger.remediatedIds(summary.projectId) });
    const { toRemediate, need, shortfall } = allocations.need(summary.projectId, risks, figures);
    return {
      ...allocations.balance(summary.projectId),
      toTriage: Object.fromEntries(SEVERITIES.map((s) => [s, figures.toTriage([s])])),
      // The rows behind those results: rows sharing one Checkmarx One result are triaged, and charged, once.
      toTriageRows: Object.fromEntries(SEVERITIES.map((s) => [s, figures.triageRows([s]).length])),
      // Confirmed findings to remediate, by severity, so any choice of severities can be costed.
      toRemediateBySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, figures.toRemediate([s])])),
      toRemediate,
      need,
      shortfall,
      sharedResults: sharedResults(figures.triageRows(SEVERITIES)),
      // Where its findings stand on the way to Mission Zero (src/journey.js).
      journey: journeyOf(risks, creditLedger.remediatedIds(summary.projectId)),
    };
  }

  /**
   * Findings still to triage that are one Checkmarx One result (several code
   * paths, or data flows, into the same vulnerable code): triaged, charged and
   * fixed together. Named so people can see which ones, and why.
   */
  function sharedResults(rows) {
    const groups = new Map();
    for (const r of rows) {
      const unit = billingUnit(r);
      if (!groups.has(unit)) groups.set(unit, []);
      groups.get(unit).push(r);
    }
    const place = (location) => String(location ?? '').replace(/^.*[\\/]/, '');
    return [...groups.entries()]
      .filter(([, list]) => list.length > 1)
      .slice(0, 30)
      .map(([unit, list]) => ({
        severity: list[0].severity,
        title: list[0].title,
        findings: list.length,
        places: [...new Set(list.map((r) => place(r.location)).filter(Boolean))].slice(0, 4),
        // How Checkmarx One ties them: one result id (listed once per code path), or one similarity group (the same vulnerable code).
        tie: unit.startsWith('a:') ? 'result' : 'group',
        id: unit.slice(2, 10),
      }));
  }

  return { creditView };
}

/**
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function createCreditRules(d) {
  const {
    settingsStore, creditLedger, allocations, audit, diagnostics, reportGrants, resolveAutomationSession, labs,
  } = d;
  /** Credits given to projects for Fusion scans and not used yet (Credits → Fusion credits): never for Triage or Remediation. */
  const fusionHeld = () => Number(d.fusionHeld?.()) || 0;

  // ---------------------------------------------------------------------------
  // Relay for the emailed report
  //
  // Checkmarx One does not accept API calls from a page opened as a local file,
  // so the report's AI Triage actions come here and run on this server's own
  // stored connection (CX_API_KEY, or the key armed for automation). Only
  // findings carrying a valid grant from the report are ever acted on.
  // ---------------------------------------------------------------------------

  const RELAY_MAX_FINDINGS = 500;

  /**
   * What someone acting from a report is told when Checkmarx One fails: the kind
   * of failure, not the raw upstream text. That text (hosts, paths, response
   * bodies) is for administrators, and stays in the audit log and server log.
   */
  function relayError(error) {
    const status = Number(error?.status) || 0;
    if (status === 401 || status === 403) return 'Checkmarx One refused the request. Ask your security team to check the CxMissionZero server.';
    if (status === 402) return 'Checkmarx One has no AI credits left for this.';
    if (status === 404) return 'Checkmarx One could not find this finding.';
    if (status === 429) return 'Checkmarx One is busy. Try again in a minute.';
    if (status >= 400 && status < 500) return `Checkmarx One did not accept the request (${status}).`;
    return 'Checkmarx One could not be reached. Try again later.';
  }

  /**
   * What a report sends to name a finding is short: ids, a project's name, the engine. Anything longer is not from a
   * report, and is refused before it is looked at (or written anywhere).
   */
  const RELAY_FIELD_MAX = { projectId: 200, projectName: 512, riskId: 512, scanId: 200, scanner: 40, alternateId: 512, groupId: 512, grant: 512 };
  const RELAY_FIELDS = [...Object.entries(RELAY_FIELD_MAX), ['exp', 40]];
  /** (Run for every finding of every report request: a plain loop, nothing made along the way.) */
  function relayFieldsFit(raw) {
    if (raw === null || typeof raw !== 'object') return true;
    for (let i = 0; i < RELAY_FIELDS.length; i += 1) {
      const value = raw[RELAY_FIELDS[i][0]];
      if (value === undefined || value === null) continue;
      if ((typeof value === 'string' ? value : String(value)).length > RELAY_FIELDS[i][1]) return false;
    }
    return true;
  }

  /**
   * Refused report requests are written to the audit log, but only so many: nobody has signed in on these routes, so
   * without a limit anyone who can reach the server could fill the disk with them. Past REFUSED_AUDIT_PER_MINUTE
   * from one address (or four times that from everyone) in a minute, the rest are counted, and one line says how
   * many were left out.
   */
  const REFUSED_AUDIT_PER_MINUTE = 10;
  /** One count per kind of refusal, so a flood of one kind never hides another: kind -> { since, total, byKey, leftOut }. */
  const refusedAudits = new Map();
  const REFUSED_KINDS = {
    report: { perKey: REFUSED_AUDIT_PER_MINUTE, total: REFUSED_AUDIT_PER_MINUTE * 4, what: 'refused report requests' },
    licence: { perKey: REFUSED_AUDIT_PER_MINUTE, total: REFUSED_AUDIT_PER_MINUTE * 4, what: 'refused product activation codes' },
    signIn: { perKey: 30, total: 120, what: 'refused sign-ins' },
  };
  /** May one more refusal from `key` (an address, a report) be listed in the audit log this minute? */
  function refusalListed(key, now = Date.now(), kind = 'report') {
    const limits = REFUSED_KINDS[kind];
    let state = refusedAudits.get(kind);
    if (!state) refusedAudits.set(kind, (state = { since: 0, total: 0, byKey: new Map(), leftOut: 0 }));
    if (now - state.since >= 60_000) {
      if (state.leftOut) {
        audit.record({ type: 'access', outcome: 'refused', reason: `${state.leftOut} more ${limits.what} in the minute before were not listed one by one (too many at once).`, actor: SYSTEM_ACTOR });
      }
      Object.assign(state, { since: now, total: 0, leftOut: 0 });
      state.byKey.clear();
    }
    const seen = state.byKey.get(key) ?? 0;
    if (seen >= limits.perKey || state.total >= limits.total) {
      state.leftOut += 1;
      return false;
    }
    // (The map cannot grow past the total allowed in a minute.)
    state.byKey.set(key, seen + 1);
    state.total += 1;
    return true;
  }
  const mayAuditRefusal = (req, now = Date.now()) => refusalListed(`address ${clientIp(req)}`, now);

  function grantedFindings(req, res, { type = '', actor = null, list: given = req.body?.findings } = {}) {
    const list = Array.isArray(given) ? given : [];
    if (list.length === 0 || list.length > RELAY_MAX_FINDINGS) {
      res.status(400).json({ error: `Send between 1 and ${RELAY_MAX_FINDINGS} findings.` });
      return null;
    }
    if (!list.every(relayFieldsFit)) {
      res.status(400).json({ error: 'This request is not from a report.' });
      return null;
    }
    const findings = [];
    for (const raw of list) {
      const finding = {
        projectId: String(raw?.projectId ?? ''),
        projectName: String(raw?.projectName ?? ''),
        riskId: String(raw?.riskId ?? ''),
        scanId: String(raw?.scanId ?? ''),
        scanner: String(raw?.scanner ?? '').toUpperCase(),
        alternateId: String(raw?.alternateId ?? ''),
        groupId: String(raw?.groupId ?? ''),
        exp: raw?.exp,
        grant: raw?.grant,
      };
      const problem = reportGrants.verify(finding);
      if (problem && type && mayAuditRefusal(req)) {
        audit.record({
          type,
          outcome: 'refused',
          reason: problem === 'expired' ? 'Report expired.' : 'Report permission did not verify (altered or forged request).',
          actor,
          project: { id: finding.projectId, name: finding.projectName },
          findings: [{ riskId: finding.riskId, alternateId: finding.alternateId, scanId: finding.scanId, scanner: finding.scanner }],
          credits: { kind: type, requested: 0, charged: 0 },
        });
      }
      if (problem) {
        res.status(403).json({
          error: problem === 'expired'
            ? 'This report has expired. Ask for a new one to triage from it.'
            : 'This report is not authorised for that action.',
        });
        return null;
      }
      findings.push(finding);
    }
    return findings;
  }

  async function relaySession(res) {
    const session = await resolveAutomationSession();
    if (!session) {
      res.status(503).json({
        error:
          'The CxMissionZero server has no stored Checkmarx One connection. ' +
          'Set CX_API_KEY, or arm automation on its Settings page.',
      });
    }
    return session;
  }

  /** The administrator's switch: AI Triage from reports spends this server's credits. */
  const ACTION_NAMES = { enabled: 'AI Triage', remediationEnabled: 'AI Remediation' };

  /** The administrator's switches: actions from reports spend this server's credits. */
  function actionAllowed(res, flag = 'enabled') {
    if (settingsStore.get().aiTriage?.[flag]) return true;
    res.status(403).json({
      error: `${ACTION_NAMES[flag]} from reports is switched off. Ask your Checkmarx One reminder administrator to allow it.`,
    });
    return false;
  }
  const triageAllowed = (res) => actionAllowed(res, 'enabled');

  /** The credit pool's period: 'month' (refills monthly) or 'all' (one pool). */
  const poolPeriod = (settings = settingsStore.get()) => (settings.aiTriage?.poolPeriod === 'all' ? 'all' : 'month');
  /** Who asks to spend, for Govern's spend guard (beta): the person's email, or the emailed report's recipient. */
  const governRequester = (actor) => String(actor?.email || actor?.recipient || '').toLowerCase();
  const creditsRemaining = () => creditLedger.remaining(settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0, new Date(), poolPeriod());

  /** The tenant's credits as last read from Checkmarx One, and this app's spending total then. */
  let tenantSeen = null;
  /**
   * What the tenant has left in Checkmarx One now: as last read, less what this app has spent since. Null when never
   * read. A read older than a couple of minutes is refreshed behind, through the session that read it.
   */
  function tenantLeft() {
    if (!tenantSeen) return null;
    if (Date.now() - tenantSeen.at > TENANT_CREDITS_MS && tenantSeen.session?.client) tenantCreditsOf({ session: tenantSeen.session }, { wait: false }).catch(() => {});
    const spent = creditLedger.usedInPeriod('all').total - tenantSeen.spent;
    return Math.max(0, tenantSeen.available - Math.max(0, spent));
  }
  /** Why `credits` more cannot be spent: the tenant has too few left in Checkmarx One. Empty when they fit, or nothing is known. */
  function tenantShortfall(credits) {
    const left = tenantLeft();
    if (left === null) return '';
    const free = Math.max(0, left - creditLedger.reserved);
    return credits > free ? `Checkmarx One has ${free.toLocaleString('en')} credit${free === 1 ? '' : 's'} left for this tenant, ${credits} needed. Ask your administrator.` : '';
  }
  /** "this month's credit pool of 500" / "the credit pool of 500", for messages. */
  const poolName = (limit) => `${poolPeriod() === 'all' ? 'the credit pool' : "this month's credit pool"} of ${limit}`;

  /** Where report readers ask for more credits: the configured contact, else the sender address. */
  function adminContact(settings = settingsStore.get()) {
    return settings.aiTriage?.adminContact || settings.smtp?.fromAddress || '';
  }

  const KIND_NAMES = { triage: 'AI Triage', remediation: 'AI Remediation' };

  /** Each project's credits, as a report shows them. */
  function projectCredits(projectIds) {
    const out = {};
    for (const projectId of new Set(projectIds)) {
      const b = allocations.balance(projectId);
      out[projectId] = { triage: b.triage, remediation: b.remediation, severities: b.severities };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Audit: every credit decision, attributed and traceable
  // ---------------------------------------------------------------------------

  const balanceOf = (projectId, kind) => {
    const { allocated, used, remaining } = allocations.balance(projectId)[kind];
    return { allocated, used, remaining };
  };

  /** One audit entry for a credit decision about `findings` (all in one project). */
  function auditCredit({ id, type, outcome, reason = '', actor, findings = [], kind, requested = 0, charged = 0, before, upstream, details }) {
    const first = findings[0];
    const project = first ? { id: first.projectId, name: first.projectName } : undefined;
    const settings = settingsStore.get().aiTriage ?? {};
    const what = kind === 'remediation' ? 'AI Remediation' : 'AI Triage';
    const defaultReason =
      outcome === 'charged'
        ? `${what} started for ${findings.length} finding(s): ${charged} credit(s) charged${actor?.kind === 'report' && actor.reportToken === 'missing' ? ' (report without identity, sent before auditing)' : ''}.`
        : outcome === 'not-charged'
          ? `${what} accepted; Checkmarx One started no new job, so nothing was charged.`
          : '';
    return audit.record({
      ...(id ? { id } : {}),
      type,
      outcome,
      reason: reason || defaultReason,
      actor,
      project,
      findings: findings.map((f) => ({ riskId: f.riskId, alternateId: f.alternateId, scanId: f.scanId, scanner: f.scanner, ...(f.severity ? { severity: f.severity } : {}) })),
      credits: { kind, requested, charged },
      balance: project ? { before: before ?? balanceOf(project.id, kind), after: balanceOf(project.id, kind) } : undefined,
      month: { limit: settings.monthlyCreditLimit ?? 0, period: settings.poolPeriod === 'all' ? 'all' : 'month', remaining: creditsRemaining() },
      upstream,
      details,
    });
  }

  /** The settings that govern credit spending (secrets as a changed/unchanged fingerprint only). */
  function creditSettingsOf(settings) {
    const ai = settings.aiTriage ?? {};
    const token = settings.beta?.github?.token ?? '';
    return {
      aiTriageEnabled: Boolean(ai.enabled),
      remediationEnabled: Boolean(ai.remediationEnabled),
      monthlyCreditLimit: ai.monthlyCreditLimit ?? 0,
      poolPeriod: ai.poolPeriod === 'all' ? 'all' : 'month',
      allowRetriage: Boolean(ai.allowRetriage),
      allowReremediation: Boolean(ai.allowReremediation),
      skipNotExploitable: ai.skipNotExploitable !== false,
      adminContact: ai.adminContact ?? '',
      githubToken: token ? `set (${createHash('sha256').update(token).digest('hex').slice(0, 8)})` : 'not set',
    };
  }

  function auditSettings(actor, before, after) {
    const changes = {};
    for (const key of Object.keys(after)) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { from: before[key], to: after[key] };
    }
    if (!Object.keys(changes).length) return null;
    return audit.record({
      type: 'settings',
      outcome: 'changed',
      reason: `Changed: ${Object.keys(changes).join(', ')}`,
      actor,
      credits: { kind: 'settings', requested: 0, charged: 0 },
      details: { changes },
    });
  }

  /** A project's allocation as the audit log records it. */
  function allocationSnapshot(projectId) {
    const b = allocations.balance(projectId);
    return {
      severities: b.severities,
      extraTriage: b.extraTriage,
      extraRemediation: b.extraRemediation,
      triage: { allocated: b.triage.allocated, used: b.triage.used, remaining: b.triage.remaining },
      remediation: { allocated: b.remediation.allocated, used: b.remediation.used, remaining: b.remediation.remaining },
    };
  }

  /** Record an allocation change for a project when something actually changed. */
  function auditAllocation({ actor, projectId, projectName, before, change, reason, outcome = 'changed' }) {
    const after = allocationSnapshot(projectId);
    if (JSON.stringify(before) === JSON.stringify(after)) return null;
    return audit.record({
      type: 'allocation',
      outcome,
      reason,
      actor,
      project: { id: projectId, name: projectName },
      credits: {
        kind: 'allocation',
        requested: 0,
        charged: 0,
        triageDelta: after.triage.allocated - before.triage.allocated,
        remediationDelta: after.remediation.allocated - before.remediation.allocated,
      },
      details: { change, before, after },
    });
  }

  // Earlier releases allocated on their own: those allocations were dropped at start-up (src/credit-allocations.js).
  if (allocations.migrated?.length) {
    for (const m of allocations.migrated) {
      audit.record({
        type: 'allocation',
        outcome: 'changed',
        reason: `Allocations made automatically by an earlier release removed: credits are now allocated only when someone confirms it. Kept what was used and extra credits not used yet.`,
        actor: SYSTEM_ACTOR,
        project: { id: m.projectId, name: m.projectName },
        credits: { kind: 'allocation', requested: 0, charged: 0, triageDelta: m.after.triage - m.before.triage, remediationDelta: m.after.remediation - m.before.remediation },
        details: { before: m.before, after: m.after },
      });
    }
    console.log(`[credits] ${allocations.migrated.length} project allocation(s) made automatically by an earlier release were removed; allocate on the Workbench.`);
  }

  /** How many findings a refused request's audit entry lists; the rest are counted. */
  const REFUSED_FINDINGS_LISTED = 20;

  /**
   * A whole request turned away before anything was sent: one entry per project. From a report (nobody signed in)
   * only so many a minute are listed, by the report and the address it came from, and each lists a few of its
   * findings and counts the rest: a report's holder could otherwise repeat a refused request with hundreds of
   * findings until the audit log, which is never trimmed, filled the disk.
   */
  function auditRefusedRequest(type, actor, findings, reason, outcome = 'refused') {
    const kind = type === 'remediation' ? 'remediation' : 'triage';
    const perFinding = kind === 'remediation' ? CREDIT_COST.remediation : 1;
    const fromReport = actor?.kind === 'report';
    const byProject = new Map();
    for (const f of findings) {
      if (!byProject.has(f.projectId)) byProject.set(f.projectId, []);
      byProject.get(f.projectId).push(f);
    }
    for (const group of byProject.values()) {
      if (fromReport && !refusalListed(`report ${actor.reportId || actor.ip || ''}`)) continue;
      const listed = fromReport ? group.slice(0, REFUSED_FINDINGS_LISTED) : group;
      auditCredit({
        type,
        outcome,
        reason,
        actor,
        findings: listed,
        kind,
        requested: new Set(group.map((f) => f.alternateId)).size * perFinding,
        ...(listed.length < group.length ? { details: { findingsInRequest: group.length, findingsListed: listed.length } } : {}),
      });
    }
  }

  /**
   * A report's identity (who it was sent to) must be intact: an altered one
   * would spend credits under someone else's name. Reports without one (sent
   * before auditing) are still honoured and logged as unattributed.
   */
  function attributedReport(res, type, actor, findings) {
    if (actor.reportToken !== 'invalid') return true;
    auditRefusedRequest(type, actor, findings, 'Report identity did not verify (altered recipient or report id).');
    res.status(403).json({ error: 'This report could not be verified. Open the report from its original email.' });
    return false;
  }

  /** What a refused request needed, for the report's "ask your administrator" message. */
  function creditNeed(projectId, projectName, kind, needed) {
    return { projectId, projectName, kind, needed, left: allocations.balance(projectId)[kind].remaining, adminContact: adminContact() };
  }

  /** Why `credits` of `kind` cannot be spent on this project now, or '' when they can. */
  function creditRefusal(projectId, projectName, kind, credits, limit) {
    const project = projectName || projectId;
    const left = allocations.balance(projectId)[kind].remaining;
    if (credits > left) {
      diagnostics.discrepancy('credit-refused', { kind, credits, project: projectId, reason: left === 0 ? 'none allocated' : 'too few allocated' });
      return left === 0
        ? `${project} has no ${KIND_NAMES[kind]} credits left (${credits} needed). Ask your administrator to allocate more.`
        : `${project} has ${left} ${KIND_NAMES[kind]} credit${left === 1 ? '' : 's'} left, ${credits} needed. Ask your administrator to allocate more.`;
    }
    const monthLeft = creditLedger.remaining(limit, new Date(), poolPeriod());
    if (monthLeft !== null && credits > monthLeft) {
      const name = poolName(limit);
      return `${name[0].toUpperCase()}${name.slice(1)} is used up — the credit limit for actions from reports (${monthLeft} left, ${credits} needed). Ask your administrator to raise it.`;
    }
    return tenantShortfall(credits);
  }

  /** The credit pool now: size, used (triage / remediation), left, given to projects, free to give. */
  /** How long the tenant's Checkmarx One credits, once read, are taken as they are. */
  const TENANT_CREDITS_MS = 2 * 60 * 1000;
  /** A session's read of the tenant's credits still under way (one at a time). */
  const tenantCreditReads = new WeakMap();
  /**
   * The tenant's credits in Checkmarx One (GET /api/credits/info), read with this session's connection and kept for a
   * short while; null when there is no connection or Checkmarx One does not say. Once known, an older figure is
   * answered at once while it is read again behind; `fresh` waits for a new read (setting the pool), `wait: false`
   * never waits (a page that only shows it).
   */
  async function tenantCreditsOf(req, { fresh = false, wait = true } = {}) {
    const session = req.session;
    const client = session?.client;
    if (!client) return null;
    const kept = session.tenantCredits;
    if (!fresh && kept && Date.now() - kept.at < TENANT_CREDITS_MS) return kept.value;
    let read = tenantCreditReads.get(session);
    if (!read) {
      read = tenantCredits(client, { background: !fresh })
        .catch(() => null)
        .then((value) => {
          session.tenantCredits = { at: Date.now(), value };
          labs.noteCredits(value);
          if (value) tenantSeen = { available: value.available, spent: creditLedger.usedInPeriod('all').total, at: Date.now(), session };
          return value;
        })
        .finally(() => tenantCreditReads.delete(session));
      tenantCreditReads.set(session, read);
    }
    if (fresh) return read;
    if (kept) return kept.value;
    return wait ? read : null;
  }

  /**
   * Why giving `given` more credits to projects is refused: projects would then hold more than the tenant has left in
   * Checkmarx One (what they were given and have not used yet, plus these). Null when it fits, or nothing is known.
   */
  async function tenantRefusal(req, given, pool = creditPool()) {
    if (!given) return null;
    const tenant = await tenantCreditsOf(req);
    if (!tenant) return null;
    // What Fusion holds counts too: the tenant's credits are given once, to Triage & Remediation or to Fusion.
    const fusion = fusionHeld();
    const held = (pool.outstanding?.total ?? 0) + fusion + given;
    if (held <= tenant.available) return null;
    return `Checkmarx One has ${tenant.available.toLocaleString('en')} credit${tenant.available === 1 ? '' : 's'} left for this tenant; projects would then hold ${held.toLocaleString('en')} (${(pool.outstanding?.total ?? 0).toLocaleString('en')} given and not used yet${fusion ? `, ${fusion.toLocaleString('en')} given for Fusion scans and not used yet` : ''}, ${given.toLocaleString('en')} more).`;
  }

  function creditPool(settings = settingsStore.get(), list = allocations.list()) {
    const period = poolPeriod(settings);
    const pool = poolSummary({
      size: settings.aiTriage?.monthlyCreditLimit ?? 0,
      period,
      used: creditLedger.usedInPeriod(period),
      reserved: creditLedger.reserved,
      allocations: list,
    });
    // What the tenant has left in Checkmarx One bounds the pool: a pool with more left than that is flagged.
    const left = tenantLeft();
    const overTenant = left !== null && pool.limited && pool.remaining > left;
    // Nor can projects be given more than the tenant has left.
    const fusion = fusionHeld();
    const unallocated = overTenant || (left !== null && fusion > 0) ? Math.min(pool.unallocated, Math.max(0, left - pool.outstanding.total - fusion)) : pool.unallocated;
    return { ...pool, unallocated, tenantLeft: left, overTenant };
  }

  return {
    relayError, refusalListed, grantedFindings, relaySession, actionAllowed, triageAllowed, poolPeriod,
    governRequester, creditsRemaining, tenantLeft, tenantShortfall, poolName, adminContact, projectCredits,
    balanceOf, auditCredit, creditSettingsOf, auditSettings, allocationSnapshot, auditAllocation,
    auditRefusedRequest, attributedReport, creditNeed, creditRefusal, tenantCreditsOf, tenantRefusal, creditPool,
  };
}
