/**
 * Who did it, for the audit log: the person behind a request from the dashboard (adminActor), and the recipient
 * of the emailed report a request came from (reportActor). Every area that records a change names its actor
 * with one of these, so they are made once in src/server.js, before the routes, and handed to each. (What the
 * server does by itself is recorded as SYSTEM_ACTOR, in src/routes/shared.js.)
 */
import { clientIp } from './shared.js';

/**
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function createActors(d) {
  const { iam, reportGrants } = d;

  /** Who acts through an emailed report: the signed recipient, where from. */
  function reportActor(req) {
    const token = req.body?.report;
    const report = reportGrants.verifyReport(token);
    return {
      kind: 'report',
      recipient: report?.recipient || '',
      reportId: report?.id || '',
      reportVerified: Boolean(report),
      // Reports sent before auditing carry no identity; an altered one is refused.
      reportToken: report ? 'valid' : token ? 'invalid' : 'missing',
      ip: clientIp(req),
      userAgent: String(req.get('user-agent') ?? '').slice(0, 200),
    };
  }

  /** Who acts from the dashboard: the Checkmarx One user behind the session's API key. */
  async function adminActor(req) {
    const session = req.session;
    const user = req.user ?? (session?.userId ? iam.user(session.userId) : null);
    let tenant = '';
    try {
      tenant = session?.connection?.tenant ?? '';
    } catch {}
    return {
      kind: 'user',
      user: user?.email ?? '',
      name: user?.name ?? '',
      email: user?.email ?? '',
      role: user ? (iam.role(user.role)?.name ?? user.role) : '',
      via: session?.via === 'cxone' ? `Checkmarx One key${session.cxUser ? ` (${session.cxUser})` : ''}` : session?.via === 'sso' ? 'single sign-on' : 'password',
      tenant,
      ip: clientIp(req),
      userAgent: String(req.get('user-agent') ?? '').slice(0, 200),
    };
  }

  return { reportActor, adminActor };
}
