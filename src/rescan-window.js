/**
 * The developer's turn to rescan.
 *
 * When every finding in a tracked report's round has been dealt with, the
 * developers who fixed them get the first chance to prove it: a Rescan button
 * (in their report, and by email) for a window of at least 24 hours (48 by
 * default, at most 14 days). If nobody rescans by then and automatic
 * verification is on, CxMissionZero rescans on their behalf and tells them; the
 * result comes back to them as an updated report either way.
 *
 *   closed, no window yet      → open it (and email the developers)
 *   open, the window has ended → rescan on their behalf (automatic verification on)
 *   scope reopened meanwhile   → close the window again (nothing to prove yet)
 */

import { timingSafeEqual } from 'node:crypto';

export const GRACE_HOURS = { min: 24, default: 48, max: 336 };
/** One hour. VERIFY_HOUR_MS shortens it, for tests only: windows of 24 hours and more cannot be waited out. */
export const HOUR_MS = Number(process.env.VERIFY_HOUR_MS) > 0 ? Number(process.env.VERIFY_HOUR_MS) : 3_600_000;

/** The window this report gives its developers, in hours (24 to 336). */
export function graceHoursOf(report) {
  const hours = Math.round(Number(report?.verify?.graceHours));
  if (!Number.isFinite(hours) || hours <= 0) return GRACE_HOURS.default;
  return Math.min(GRACE_HOURS.max, Math.max(GRACE_HOURS.min, hours));
}

/** This round's window, or null. */
export const currentWindow = (report) => (report?.verifyWindow && report.verifyWindow.round === (report.round ?? 1) ? report.verifyWindow : null);

/** What the window needs now: 'open', 'start' (on the developers' behalf), 'cancel', or null. */
export function windowAction(report, now = Date.now()) {
  const round = report.round ?? 1;
  if (report.verification?.round === round) return null; // this round is being (or was) verified
  const closed = Boolean(report.latest?.closure?.closed);
  const window = currentWindow(report);
  if (!closed) return window && !window.startedAt ? 'cancel' : null;
  if (!window) return 'open';
  if (!window.startedAt && report.verify?.auto && now >= Date.parse(window.dueAt)) return 'start';
  return null;
}

/** A new window for this round, opened now. */
export function newWindow(report, developers = [], now = Date.now()) {
  const hours = graceHoursOf(report);
  return {
    round: report.round ?? 1,
    openedAt: new Date(now).toISOString(),
    dueAt: new Date(now + hours * HOUR_MS).toISOString(),
    graceHours: hours,
    developers,
    startedAt: null,
    startedBy: '',
  };
}

/** Where the window stands, for a developer's report or page. */
export function windowState(report, now = Date.now()) {
  const round = report.round ?? 1;
  const v = report.verification?.round === round ? report.verification : null;
  if (v) {
    if (v.result) return { state: v.result.zero ? 'zero' : 'verified', result: { fixed: v.result.fixed, stillFound: v.result.stillFound.length, newInScope: v.result.newInScope } };
    return { state: 'scanning', startedBy: v.by || '', automatic: Boolean(v.automatic) };
  }
  const window = currentWindow(report);
  if (!window) return { state: report.latest?.closure?.closed ? 'opening' : 'open-findings', open: report.latest?.closure?.open ?? null };
  return { state: 'ready', dueAt: window.dueAt, hoursLeft: Math.max(0, Math.ceil((Date.parse(window.dueAt) - now) / HOUR_MS)), onBehalf: Boolean(report.verify?.auto) };
}

/**
 * Signed rescan grants: who may start the rescan of which report's round, until when.
 * `mac(text)` is the server's report-signing HMAC.
 */
export function rescanGrants(mac) {
  const sign = (text) => mac(`rescan\n${text}`);
  return {
    issue({ reportId, round, email, exp }) {
      const body = Buffer.from(JSON.stringify({ t: String(reportId), n: Number(round) || 1, r: String(email || ''), e: Number(exp) })).toString('base64url');
      return `${body}.${sign(body)}`;
    },
    /** {reportId, round, email} when valid and not expired; null otherwise. */
    verify(token, now = Date.now()) {
      const [body, sig] = String(token ?? '').split('.');
      if (!body || !sig || body.length > 2000) return null;
      const expected = Buffer.from(sign(body));
      const given = Buffer.from(sig);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!(p.e > now)) return null;
        return { reportId: String(p.t), round: Number(p.n) || 1, email: String(p.r || '') };
      } catch {
        return null;
      }
    },
  };
}
