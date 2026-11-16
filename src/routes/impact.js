/**
 * The Impact page (src/impact.js, src/impact-summary.js): what the work has changed, from the finding journal and
 * the credit ledger. The routes under /api/impact (the figures, the summary as a page, the summary by email) and
 * the monthly summary that goes out by itself (monthlyImpact, run by the background jobs of src/server.js).
 */
import { computeImpact } from '../impact.js';
import { impactSummary } from '../impact-summary.js';
import { sendReminderMail } from '../mailer.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerImpactRoutes(app, d) {
  const {
    settingsStore, creditLedger, findingJournal, audit, terms, automationState, asyncRoute, brandingNow, can,
    requirePermission, sendingSettings, resolveReportServer, adminActor, readerLook,
  } = d;

  // ---------------------------------------------------------------------------
  // Impact: what AI Triage and AI Remediation did for the backlog (src/impact.js)
  // ---------------------------------------------------------------------------

  const IMPACT_DAYS = ['30', '90', '365', 'all'];

  /** The Impact figures for the last `days` days ('all': since the first reading), or for [from, to). */
  function impactFor({ days = '90', from = null, to = null, settings = settingsStore.get().impact } = {}, now = new Date()) {
    const start = from ?? (days === 'all' ? '0000-01-01T00:00:00.000Z' : new Date(now.getTime() - Number(days) * 86_400_000).toISOString());
    return computeImpact({
      journal: findingJournal.entries(),
      ledger: creditLedger.entriesBetween('0000', '9999'),
      settings,
      from: start,
      to,
      now,
    });
  }

  const impactPeriodLabel = (days) => (days === 'all' ? 'since the first reading' : `last ${days} days`);

  /**
   * The Impact settings for this person: their own figures from Your profile → Your Impact figures,
   * the organisation's for any they left empty. With a currency of their own, the organisation's
   * hourly cost and credit price (in another currency) are not used: only theirs, or none.
   * `personal`: which figures are theirs (null: none).
   */
  function impactSettingsFor(user) {
    const org = settingsStore.get().impact;
    const p = user?.profile?.impact ?? {};
    const own = Boolean(p.currency) && p.currency !== org.currency;
    const settings = {
      ...org,
      currency: own ? p.currency : org.currency,
      hourlyRate: p.hourlyRate ?? (own ? 0 : org.hourlyRate),
      creditPrice: p.creditPrice ?? (own ? 0 : org.creditPrice),
      triageMinutes: p.triageMinutes ?? org.triageMinutes,
      fixMinutes: p.fixMinutes ?? org.fixMinutes,
    };
    const personal = [...(own ? ['currency'] : []), ...['hourlyRate', 'creditPrice', 'triageMinutes', 'fixMinutes'].filter((k) => p[k] !== null && p[k] !== undefined)];
    return { settings, personal: personal.length ? personal : null };
  }

  app.get('/api/impact', requirePermission('reports.view'), (req, res) => {
    const days = IMPACT_DAYS.includes(String(req.query.days)) ? String(req.query.days) : '90';
    const { monthlyTo, currency: organisationCurrency } = settingsStore.get().impact;
    const mine = impactSettingsFor(req.user);
    res.json({ ...impactFor({ days, settings: mine.settings }), personal: mine.personal, organisationCurrency, days, monthlyTo: can(req, 'settings.ai') ? monthlyTo : undefined, monthlyOn: monthlyTo.length > 0, lastSent: automationState.impactSent || null });
  });

  /** One page for leadership: download it, then print or save it as PDF from the browser. */
  app.get('/api/impact/summary.html', requirePermission('reports.view'), (req, res) => {
    const days = IMPACT_DAYS.includes(String(req.query.days)) ? String(req.query.days) : '90';
    const settings = settingsStore.get();
    const mine = impactSettingsFor(req.user);
    const { html } = impactSummary(impactFor({ days, settings: mine.settings }), { appName: brandingNow(settings.branding)?.appName || 'CxMissionZero', periodLabel: impactPeriodLabel(days), personal: mine.personal, look: readerLook(req.user, settings) });
    res.set('Content-Disposition', `attachment; filename="impact-${new Date().toISOString().slice(0, 10)}.html"`);
    res.type('html').send(html);
  });

  /** The previous calendar month (UTC): its first day and the first day of this month. */
  function lastMonth(now = new Date()) {
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return { month: from.toISOString().slice(0, 7), from: from.toISOString(), to: to.toISOString() };
  }

  /** Email last month's summary to Settings → Impact's list (or `to`). Returns who it went to. */
  async function sendImpactSummary({ to = null, actor = { kind: 'system' } } = {}) {
    const settings = sendingSettings();
    const recipients = to ?? settings.impact.monthlyTo;
    if (!recipients.length) throw Object.assign(new Error('Add who gets the monthly summary first.'), { status: 400 });
    const period = lastMonth();
    const url = resolveReportServer(null, settings).url;
    const message = impactSummary(impactFor({ from: period.from, to: period.to }), {
      appName: settings.branding?.appName || 'CxMissionZero',
      periodLabel: period.month,
      email: true,
      // The organisation's look: the summary goes to a list, not to one reader.
      look: readerLook(null, settings),
      pageUrl: url ? `${url.replace(/\/$/, '')}/#/impact` : '',
    });
    await sendReminderMail(settings, message, { to: recipients, cc: [], bcc: [], exact: true });
    audit.record({ type: 'settings', outcome: 'changed', reason: `Impact summary for ${period.month} emailed to ${recipients.length} address${recipients.length === 1 ? '' : 'es'}.`, actor, details: { impact: { month: period.month, to: recipients.length } } });
    return { month: period.month, to: recipients };
  }

  app.post('/api/impact/email', requirePermission('settings.ai'), asyncRoute(async (req, res) => {
    const result = await sendImpactSummary({ actor: await adminActor(req) });
    res.json({ sent: true, ...result });
  }));

  /** Once a month, after the 1st's early hours (UTC): last month's summary, when someone is on the list. */
  async function monthlyImpact(now = new Date()) {
    const settings = settingsStore.get();
    if (!settings.impact.monthlyTo.length || !terms.organisation()) return;
    const { month } = lastMonth(now);
    if (automationState.impactSent >= month || now.getUTCHours() < 6) return;
    automationState.impactSent = month; // once, even if the mail server refuses (the audit log says so)
    await sendImpactSummary().catch((error) => {
      console.warn(`[impact] Monthly summary for ${month} not sent: ${error.message}`);
      audit.record({ type: 'settings', outcome: 'failed', reason: `Impact summary for ${month} could not be emailed: ${error.message}`, actor: { kind: 'system' }, details: { impact: { month } } });
    });
  }

  return { impactFor, monthlyImpact };
}
