/**
 * Get help (src/support.js): support cases and enhancement requests, for the whole server. The routes under
 * /api/support: a person's own requests, the support team's view of everyone's, a new request, a message, a
 * change of status, and the email that tells the other side.
 */
import { sendReminderMail } from '../mailer.js';
import { supportChannel } from '../settings.js';
import { DEFAULT_TENANT } from '../tenancy.js';
import { KINDS as SUPPORT_KINDS, STATUSES as SUPPORT_STATUSES, supportEmail } from '../support.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerSupportRoutes(app, d) {
  const {
    tenancy, settingsStore, iam, supportDesk, asyncRoute, permissionsFor, tenantsOf, requireSession, can,
    requirePermission, sendingSettings, resolveReportServer, tenantName,
  } = d;

  // ---------------------------------------------------------------------------
  // Get help: support cases and enhancements (src/support.js)
  // ---------------------------------------------------------------------------

  /** The team that answers requests raised in a tenant: active people with support.manage who work in it (a Super Admin works in every one). */
  function supportTeamOf(tenant) {
    return iam.users()
      .map((u) => iam.user(u.id))
      .filter((u) => u && !u.disabled && u.email && permissionsFor(u).has('support.manage') && tenantsOf(u).includes(tenant));
  }

  /** May this person see the request: the one who raised it, or the team of its tenant. */
  const seesRequest = (req, ticket) => ticket.requester.id === req.user.id || (can(req, 'support.manage') && tenantsOf(req.user, req.permissions).includes(ticket.tenant));

  function requestView(req, ticket, { full = false } = {}) {
    const view = {
      id: ticket.id,
      kind: ticket.kind,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      requester: { name: ticket.requester.name, email: ticket.requester.email },
      mine: ticket.requester.id === req.user.id,
      tenant: tenancy.enabled ? tenantName(ticket.tenant) : '',
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      messages: ticket.messages.length,
    };
    if (!full) return view;
    return {
      ...view,
      conversation: ticket.messages.map((m) => ({ at: m.at, name: m.by.name || m.by.email, team: m.team, mine: m.by.id === req.user.id, text: m.text })),
      history: ticket.history.map((h) => ({ at: h.at, name: h.by.name || h.by.email, status: h.status })),
    };
  }

  /**
   * Email about a request, through the mail server of the tenant it was raised in.
   * The person who raised it hears of every answer and status change; the team, of
   * every new request and every answer from that person. Never fails the request:
   * the reply says what could not be sent.
   */
  async function mailSupport(req, ticket, event, { fromTeam = false, message = null } = {}) {
    const tenant = tenancy.has(ticket.tenant) ? ticket.tenant : DEFAULT_TENANT;
    return tenancy.run(tenant, async () => {
      const settings = sendingSettings();
      const url = resolveReportServer(req, settings).url;
      // Support is between this person and the team: the organisation's name, never a demonstration's.
      const appName = settingsStore.get().branding?.appName || 'CxMissionZero';
      const self = String(req.user.email ?? '').toLowerCase();
      const jobs = [];
      if (event !== 'message' || fromTeam) {
        if (ticket.requester.email && (event === 'created' || ticket.requester.email.toLowerCase() !== self)) jobs.push(['requester', [ticket.requester.email]]);
      }
      if (!fromTeam && event !== 'status') {
        const team = [...new Set(supportTeamOf(ticket.tenant).map((u) => u.email).filter((e) => e.toLowerCase() !== self))];
        if (team.length) jobs.push(['team', team]);
      }
      const result = { sent: 0, error: '' };
      for (const [to, addresses] of jobs) {
        try {
          await sendReminderMail(settings, supportEmail(ticket, { event, to, appName, url, message }), { to: addresses, cc: [], bcc: [], exact: true });
          result.sent += addresses.length;
        } catch (error) {
          result.error = error.message;
        }
      }
      return result;
    });
  }

  app.get('/api/support', requireSession, (req, res) => {
    const team = can(req, 'support.manage');
    const visible = supportDesk.list().filter((t) => seesRequest(req, t));
    res.json({ team, statuses: SUPPORT_STATUSES, requests: visible.map((t) => requestView(req, t)) });
  });

  app.get('/api/support/:id', requireSession, (req, res) => {
    const ticket = supportDesk.get(req.params.id);
    if (!ticket || !seesRequest(req, ticket)) return res.status(404).json({ error: 'No such request, or it is not yours to see.' });
    res.json({ team: can(req, 'support.manage'), request: requestView(req, ticket, { full: true }) });
  });

  app.post('/api/support', requireSession, asyncRoute(async (req, res) => {
    const kind = req.body?.kind;
    if (!SUPPORT_KINDS[kind]) return res.status(400).json({ error: 'Choose a support case or an enhancement.' });
    const channel = supportChannel(settingsStore.get());
    if (channel.mode === 'email') return res.status(409).json({ error: `Requests go by email here: write to ${channel.email}.`, email: channel.email });
    if (supportDesk.raisedSince(req.user.id, new Date(Date.now() - 3_600_000).toISOString()) >= 20) {
      return res.status(429).json({ error: 'You raised 20 requests in the last hour. Add to one of them instead, or try again later.' });
    }
    const ticket = supportDesk.create({
      kind,
      tenant: req.tenantId ?? DEFAULT_TENANT,
      subject: req.body?.subject,
      text: req.body?.text,
      priority: req.body?.priority,
      requester: { id: req.user.id, name: req.user.name, email: req.user.email },
    });
    const emailed = await mailSupport(req, ticket, 'created');
    res.status(201).json({ request: requestView(req, ticket, { full: true }), emailed });
  }));

  app.post('/api/support/:id/messages', requireSession, asyncRoute(async (req, res) => {
    const ticket = supportDesk.get(req.params.id);
    if (!ticket || !seesRequest(req, ticket)) return res.status(404).json({ error: 'No such request, or it is not yours to see.' });
    // Someone who both raised it and is on the team answers as the person who raised it.
    const fromTeam = ticket.requester.id !== req.user.id;
    supportDesk.reply(ticket.id, { by: { id: req.user.id, name: req.user.name, email: req.user.email }, team: fromTeam, text: req.body?.text });
    const emailed = await mailSupport(req, ticket, 'message', { fromTeam, message: ticket.messages.at(-1).text });
    res.json({ request: requestView(req, ticket, { full: true }), emailed });
  }));

  app.post('/api/support/:id/status', requirePermission('support.manage'), asyncRoute(async (req, res) => {
    const ticket = supportDesk.get(req.params.id);
    if (!ticket || !seesRequest(req, ticket)) return res.status(404).json({ error: 'No such request, or it is not yours to see.' });
    const before = ticket.status;
    supportDesk.setStatus(ticket.id, String(req.body?.status ?? ''), { by: { id: req.user.id, name: req.user.name, email: req.user.email } });
    const emailed = ticket.status === before ? { sent: 0, error: '' } : await mailSupport(req, ticket, 'status', { fromTeam: true });
    res.json({ request: requestView(req, ticket, { full: true }), emailed });
  }));
}
