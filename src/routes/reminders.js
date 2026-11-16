/**
 * Reminder emails from the Workbench (src/reminder.js, src/mailer.js): which findings a reminder is about (the
 * scope asked for, without the ones triaged as not exploitable), who they go to (the people who started the
 * scans, a list, or both), the run itself (runReminder), and POST /api/reminders. Tracked reports and the HTML
 * report send through the same scope and groups.
 */
import { selectRisks } from '../cxone/risks.js';
import { groupRisksByInitiator, groupRisksByProject } from '../cxone/initiators.js';
import { mapWithConcurrency } from '../cxone/client.js';
import { alreadySent } from '../credit-allocations.js';
import { buildReminder } from '../reminder.js';
import { sendReminderMail } from '../mailer.js';
import { isVerified, parseAddressList } from '../settings.js';
import { idList, logSafe } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerReminderRoutes(app, d) {
  const {
    settingsStore, creditLedger, relayCache, asyncRoute, requirePermission, sendingSettings, triageLookup,
    projectStates,
  } = d;

  // ---------------------------------------------------------------------------
  // Reminders
  // ---------------------------------------------------------------------------

  const NOT_EXPLOITABLE_STATES = new Set(['NOT_EXPLOITABLE', 'PROPOSED_NOT_EXPLOITABLE']);

  /**
   * Leave out findings triaged as not exploitable (proposed or confirmed), by
   * their live Checkmarx One state — so triage the administrator ran after the
   * last fetch counts too. Only confirmed findings and those still to verify
   * stay in reminders and reports. Can be switched off in Settings.
   */
  async function withoutNotExploitable(session, risks) {
    if (settingsStore.get().aiTriage?.skipNotExploitable === false) return risks;
    const live = new Map();
    await mapWithConcurrency([...new Set(risks.map((r) => r.projectId))], 3, async (projectId) => {
      try {
        live.set(projectId, await projectStates(session, projectId));
      } catch (error) {
        console.warn(`[reminders] could not read live states for ${logSafe(projectId)}: ${logSafe(error.message)}`);
      }
    });
    const current = risks
      .map((r) => {
        const state = live.get(r.projectId)?.get(r.riskId);
        return state && state !== r.state ? { ...r, state } : r;
      })
      .filter((r) => !NOT_EXPLOITABLE_STATES.has(r.state));
    // AI Triage can propose "not exploitable" while the finding still reads To verify:
    // look at the verdict of everything this utility sent for triage, and leave those out too.
    const sent = new Map();
    const askAi = current.filter((r) => {
      if (r.state && r.state !== 'TO_VERIFY') return false;
      if (!sent.has(r.projectId)) sent.set(r.projectId, creditLedger.triagedAt(r.projectId));
      return r.groupId && alreadySent(r, sent.get(r.projectId));
    });
    const verdictNotExploitable = new Set();
    await mapWithConcurrency(askAi, 6, async (r) => {
      const { key, load, ttl } = triageLookup(session, r);
      try {
        const answer = await relayCache.wrap(key, load, ttl);
        if (NOT_EXPLOITABLE_STATES.has(String(answer?.body?.triageStatus ?? '').toUpperCase())) verdictNotExploitable.add(r);
      } catch {}
    });
    return verdictNotExploitable.size ? current.filter((r) => !verdictNotExploitable.has(r)) : current;
  }

  /**
   * The findings a reminder covers: the selected projects (all when none),
   * narrowed to the projects whose latest scan the picked initiators ran,
   * without anything not exploitable.
   */
  async function reminderScope(session, scan, { projectIds = null, buckets = [], severities = null, initiators = null } = {}) {
    const initiatorsByProject = scan.initiators ?? {};
    let scoped = idList(projectIds);
    scoped = scoped.length ? scoped : null;
    // Narrowing by initiator is a project-level filter: a finding belongs to
    // whoever ran that project's latest scan.
    if (idList(initiators, 1000).length > 0) {
      const wanted = new Set(idList(initiators, 1000));
      const matching = Object.entries(initiatorsByProject)
        .filter(([, info]) => wanted.has(info.email) || wanted.has(info.initiator))
        .map(([projectId]) => projectId);
      scoped = scoped ? matching.filter((id) => scoped.includes(id)) : matching;
    }
    const risks = await withoutNotExploitable(session, selectRisks(scan.projects, {
      projectIds: scoped,
      buckets: Array.isArray(buckets) ? buckets : [],
      severities,
    }));
    return { risks, initiatorsByProject };
  }

  /** Who ran a project's latest scan, as reminders are addressed: their email, else their username. */
  const initiatorKey = (info = {}) => info.email || info.initiator || '';

  /**
   * One group per scan initiator ('initiator') or per project ('project'). A
   * person is only ever sent projects whose latest scan they ran: checked here
   * for every group, so no format or caller can mail anyone a project that is
   * not theirs.
   */
  function initiatorGroups(risks, initiatorsByProject, groupBy) {
    const groups = groupBy === 'project' ? groupRisksByProject(risks, initiatorsByProject) : groupRisksByInitiator(risks, initiatorsByProject);
    for (const group of groups) {
      const key = group.email || group.initiator || '';
      const stray = group.risks.find((r) => !group.projectIds.includes(r.projectId) || initiatorKey(initiatorsByProject[r.projectId]) !== key);
      if (stray) {
        throw Object.assign(new Error(`Refused to send: ${stray.projectName} is not a project ${key || 'this person'} scanned.`), { status: 500 });
      }
      group.projectNames = [...new Set(group.risks.map((r) => r.projectName))].sort();
    }
    return groups;
  }

  /**
   * Build and send (or preview, with dryRun) reminders for findings of `scan`
   * — the dashboard's last fetch, or a tracked report's open findings.
   * Resolves {status, body} for the caller to send.
   */
  async function runReminder(session, scan, input) {
    const reply = (status, payload) => ({ status, body: payload });
      const {
        projectIds = null,
        buckets = [],
        severities = null,
        initiators: wantedInitiators = null,
        groupBy = 'none',
        alsoConsolidated = false,
        dryRun = false,
        recipients,
      } = input;

      const { connection } = session;
      const settings = sendingSettings();

      // An empty bucket list means "no age filter", so a selection of projects or
      // initiators is enough on its own to send.
      const ageBuckets = Array.isArray(buckets) ? buckets : [];
      const { risks, initiatorsByProject } = await reminderScope(session, scan, { projectIds, buckets: ageBuckets, severities, initiators: wantedInitiators });
      if (risks.length === 0) {
        return reply(400, { error: 'No vulnerabilities match that selection.' });
      }

      const common = {
        buckets: ageBuckets,
        tenant: connection.tenant,
        initiatorsByProject,
        links: settings.links,
        connection,
        branding: settings.branding,
      };

      // ---- One email per scan initiator -------------------------------------
      if (groupBy === 'initiator' || groupBy === 'project') {
        const groups = initiatorGroups(risks, initiatorsByProject, groupBy);
        const sendable = groups.filter((group) => group.email);
        const skipped = groups
          .filter((group) => !group.email)
          .map((group) => ({
            initiator: group.initiator || '(unknown)',
            riskCount: group.risks.length,
            projectCount: group.projectCount,
            reason: group.initiator
              ? 'No email address could be resolved for this user.'
              : 'No initiator recorded on the latest scan.',
          }));

        const prepared = sendable.map((group) => ({
          group,
          reminder: buildReminder(group.risks, settings.template, {
            ...common,
            initiator: group,
          }),
        }));

        // One extra message to the configured list, summarising everything the
        // individual messages covered, so a lead sees the whole picture.
        const consolidated =
          alsoConsolidated && settings.recipients.to.length > 0
            ? buildReminder(risks, settings.template, common)
            : null;

        if (dryRun) {
          return reply(200, {
            dryRun: true,
            groupBy,
            consolidated: consolidated
              ? { subject: consolidated.subject, html: consolidated.html, to: settings.recipients.to }
              : null,
            canSend: isVerified(settings),
            skipped,
            messages: prepared.map(({ group, reminder }) => ({
              initiator: group.initiator,
              projectName: group.projectName ?? '',
              email: group.email,
              via: group.via,
              projectCount: group.projectCount,
              projects: group.projectNames,
              riskCount: group.risks.length,
              subject: reminder.subject,
              html: reminder.html,
            })),
          });
        }

        if (prepared.length === 0) {
          return reply(400, {
            error: 'No scan initiator in this selection has a resolvable email address.',
            skipped,
          });
        }

        // Sent one at a time so a single bad address cannot lose the rest.
        const sent = [];
        const failed = [];
        for (const { group, reminder } of prepared) {
          try {
            // Exactly these addresses: without `exact`, an empty Cc/Bcc would fall
            // back to the configured list and copy everyone on this person's projects.
            const result = await sendReminderMail(settings, reminder, {
              exact: true,
              to: [group.email],
              cc: settings.initiators.copyConfiguredRecipients ? settings.recipients.cc : [],
              bcc: settings.initiators.copyConfiguredRecipients ? settings.recipients.bcc : [],
            });
            sent.push({
              initiator: group.initiator,
              projectName: group.projectName ?? '',
              email: group.email,
              riskCount: group.risks.length,
              projectCount: group.projectCount,
              projects: group.projectNames,
              messageId: result.messageId,
            });
          } catch (error) {
            failed.push({ initiator: group.initiator, email: group.email, error: error.message });
          }
        }

        if (consolidated) {
          try {
            const result = await sendReminderMail(settings, consolidated);
            sent.push({
              initiator: 'consolidated',
              email: result.recipients.to.join(', '),
              riskCount: risks.length,
              projectCount: new Set(risks.map((risk) => risk.projectId)).size,
              projects: [...new Set(risks.map((risk) => risk.projectName))].sort(),
              messageId: result.messageId,
            });
          } catch (error) {
            failed.push({ initiator: 'consolidated', email: 'list', error: error.message });
          }
        }

        return reply(200, {
          groupBy,
          delivered: sent.length > 0,
          sent,
          failed,
          skipped,
          consolidated: Boolean(consolidated),
          totalRisks: risks.length,
        });
      }

      // ---- One email to the configured recipient list ------------------------
      const reminder = buildReminder(risks, settings.template, common);

      if (dryRun) {
        return reply(200, {
          dryRun: true,
          groupBy: 'none',
          subject: reminder.subject,
          html: reminder.html,
          text: reminder.text,
          totalRisks: risks.length,
          projects: reminder.projects.length,
          recipients: settings.recipients,
          canSend: isVerified(settings),
        });
      }

      const overrides = recipients
        ? {
            exact: recipients.exact === true,
            to: parseAddressList(recipients.to ?? []),
            cc: parseAddressList(recipients.cc ?? []),
            bcc: parseAddressList(recipients.bcc ?? []),
          }
        : {};

      const result = await sendReminderMail(settings, reminder, overrides);
      return reply(200, { ...result, groupBy: 'none', totalRisks: risks.length, projects: reminder.projects.length });
    }

  app.post(
    '/api/reminders',
    requirePermission('reminders.send'),
    asyncRoute(async (req, res) => {
      if (!req.session.lastScan) {
        return res.status(409).json({ error: 'Load findings on the Workbench first, then send a reminder.' });
      }
      const { status, body } = await runReminder(req.session, req.session.lastScan, req.body ?? {});
      res.status(status).json(body);
    }),
  );

  return { NOT_EXPLOITABLE_STATES, withoutNotExploitable, reminderScope, initiatorGroups, runReminder };
}
