/**
 * The product licence and the activation codes (src/activation.js, docs/activation-codes.md).
 *
 * - /api/licence: whether CxMissionZero works, and a product code entered on the deactivation page. Open to
 *   everyone (the licence gate in src/server.js lets these two through), so refused codes are limited.
 * - /api/activation: Settings → Activation codes, the add-ons unlocked by the maintainer (activation.manage).
 */
import { ISSUER_KEYS, checkCode } from '../activation.js';
import { GATED_LANGUAGES } from '../languages.js';
import { clientIp } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerLicenceRoutes(app, d) {
  const { audit, activations, languageAccess, asyncRoute, can, requirePermission, refusalListed, adminActor } = d;

  // ---- The product licence: whether CxMissionZero works, and a product code entered on the deactivation page ----
  // Open to anyone who reaches the server: only a code the maintainer signed can do anything here.
  app.get('/api/licence', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { active, until, message } = activations.product();
    res.json({ active, until, message });
  });

  const licenceTries = new Map();
  app.post('/api/licence/activate', (req, res) => {
    // A few tries a minute from one address: a code cannot be guessed, but there is no reason to let anyone try.
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (licenceTries.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 10) return res.status(429).json({ error: 'Too many tries. Wait a minute, then enter the code again.' });
    licenceTries.set(ip, [...recent, now]);
    if (licenceTries.size > 1000) licenceTries.clear();
    const result = checkCode(String(req.body?.code ?? '').trim().slice(0, 4000));
    // In date by the licence's own clock too (never earlier than the latest time it has seen).
    const passed = result.valid && Date.parse(result.expires) <= activations.now();
    // Open to everyone: only a code that runs longer than the one in force, and was not issued before it, is taken.
    const stale = result.valid && result.scope === 'product' && !passed ? activations.refusal(result, { mustExtend: true }) : '';
    if (!result.valid || result.scope !== 'product' || passed || stale) {
      const reason = !result.valid ? result.reason || 'This activation code is not valid.' : result.scope !== 'product' ? 'This is not a CxMissionZero activation code.' : passed ? `This activation code ended on ${result.expires.slice(0, 10)}.` : stale;
      if (refusalListed(`address ${ip}`, now, 'licence')) audit.record({ type: 'settings', outcome: 'refused', reason: `Product activation code refused: ${reason}`, actor: { kind: 'system', user: `deactivation page (${ip})` } });
      return res.status(400).json({ error: reason });
    }
    activations.record(result, `deactivation page (${ip})`);
    audit.record({ type: 'settings', outcome: 'changed', reason: `Product activation code applied: CxMissionZero works until ${result.expires.slice(0, 10)} (${result.org}).`, actor: { kind: 'system', user: `deactivation page (${ip})` }, details: { activation: { id: result.id, org: result.org, scope: result.scope, action: result.action, expires: result.expires } } });
    const { active, until } = activations.product();
    res.json({ active, until });
  });

  // ---- Activation codes (Settings → Activation codes): add-ons unlocked by the maintainer ----

  function activationView(req) {
    return {
      // Seeing the page (activation.view) is not changing it.
      canManage: can(req, 'activation.manage'),
      keyConfigured: ISSUER_KEYS.length > 0,
      // Only the add-ons a code has unlocked (expired ones too, to renew): nothing else is named.
      languages: Object.fromEntries(Object.keys(GATED_LANGUAGES).map((code) => [code, languageAccess.status(code)]).filter(([, s]) => s.on || s.expired)),
      tenants: activations.tenants(),
      features: Object.fromEntries(['impact', 'faeFlush', 'govern', 'statusBoard', 'consolidated'].map((name) => [name, activations.feature(name)]).filter(([, f]) => f)),
      product: activations.product(),
      history: activations.history().slice(0, 10),
    };
  }

  app.get('/api/activation', requirePermission('activation.manage', 'activation.view'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(activationView(req));
  });

  app.post('/api/activation', requirePermission('activation.manage'), asyncRoute(async (req, res) => {
    const code = String(req.body?.code ?? '').trim().slice(0, 4000);
    const result = checkCode(code);
    const actor = await adminActor(req);
    // A deactivation code is honoured even when it is itself past its date.
    const usable = result.valid || (result.expired && result.action === 'deactivate');
    if (!usable) {
      audit.record({ type: 'settings', outcome: 'refused', reason: `Activation code refused: ${result.reason}`, actor });
      return res.status(400).json({ error: result.reason || 'This activation code is not valid.' });
    }
    // An older code entered again would undo the one in force (a feature turned off, a shorter date).
    const stale = result.scope.startsWith('lang:') ? '' : activations.refusal(result);
    if (stale) {
      audit.record({ type: 'settings', outcome: 'refused', reason: `Activation code refused: ${stale}`, actor });
      return res.status(400).json({ error: stale });
    }
    let what;
    if (result.scope.startsWith('lang:')) {
      const applied = languageAccess.apply(result, { by: req.user.id });
      what = `${applied.code === 'he' ? 'Hebrew' : applied.code} ${applied.on ? `turned on until ${result.expires.slice(0, 10)}, for the roles with its permission (People & roles)` : 'turned off'}`;
    } else if (result.scope === 'feature:impact') {
      what = `the Cx Credits Calculator's Impact tab ${result.action === 'activate' ? `turned on until ${result.expires.slice(0, 10)}` : 'turned off'}`;
    } else if (result.scope === 'feature:faeFlush') {
      what = `FAE Flush (Labs) ${result.action === 'activate' ? `turned on until ${result.expires.slice(0, 10)}, for the roles with Labs: FAE Flush` : 'turned off: a run under way pauses'}`;
    } else if (result.scope === 'feature:statusBoard') {
      what = `the Status board (Labs) ${result.action === 'activate' ? `turned on until ${result.expires.slice(0, 10)}, for the roles with Labs: Status board` : 'turned off'}`;
    } else if (result.scope === 'feature:consolidated') {
      what = `the Consolidated view (Labs) ${result.action === 'activate' ? `turned on until ${result.expires.slice(0, 10)}, for the people an Admin ticks under People & roles whose role has Labs: Consolidated view` : 'turned off'}`;
    } else if (result.scope === 'feature:govern') {
      what = `Govern (Labs) ${result.action === 'activate' ? `turned on until ${result.expires.slice(0, 10)}, for the roles with Labs: Govern` : 'turned off: its cycles stop, restrictions already made stay until restored'}`;
    } else if (result.scope === 'product') {
      what = `CxMissionZero activated for ${result.org} until ${result.expires.slice(0, 10)}`;
    } else {
      what = `several Checkmarx One tenants unlocked for ${result.org}: up to ${result.maxTenants}, until ${result.expires.slice(0, 10)}`;
    }
    activations.record(result, actor.user);
    audit.record({ type: 'settings', outcome: 'changed', reason: `Activation code applied: ${what}.`, actor, details: { activation: { id: result.id, org: result.org, scope: result.scope, action: result.action || 'activate', expires: result.expires } } });
    res.json({ applied: what, ...activationView(req) });
  }));
}
