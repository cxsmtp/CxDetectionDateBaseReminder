/**
 * Settings → Beta features (src/features.js): every Beta feature with its stage and who may use it, making one
 * final (or Beta again), and the Cx Credits Calculator, which runs at an address of its own: the switch and the
 * address are on the same page, and /calculator sends people there.
 */
import { featureById, featureList, isFinal, mayUse } from '../features.js';
import { calculatorBuiltIn } from '../settings.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerFeatureRoutes(app, d) {
  const { settingsStore, audit, scheduler, asyncRoute, currentSession, requireSession, can, requirePermission, featureLocked } = d;

  // ---------------------------------------------------------------------------
  // Beta features, and making them final (src/features.js)
  // ---------------------------------------------------------------------------

  /** Every Beta feature, its stage, and whether this person may use it and change it. */
  app.get('/api/features', requireSession, (req, res) => {
    const settings = settingsStore.get();
    res.json({
      features: featureList(settings).filter((f) => !featureLocked(f)).map(({ unlockedBy, ...f }) => ({ ...f, canUse: mayUse(settings, f.id, req.permissions) })),
      canManage: can(req, 'features.manage'),
    });
  });

  /** The Admin's switch: a feature becomes final for everyone (or goes back to Beta). Audited. */
  app.put('/api/features/:id', requirePermission('features.manage'), (req, res) => {
    const feature = featureById(req.params.id);
    if (!feature) return res.status(404).json({ error: 'No such feature.' });
    const stage = req.body?.stage === 'final' ? 'final' : req.body?.stage === 'beta' ? 'beta' : '';
    if (!stage) return res.status(400).json({ error: 'The stage must be "beta" or "final".' });
    const before = isFinal(settingsStore.get(), feature.id) ? 'final' : 'beta';
    if (before !== stage) {
      settingsStore.save({ features: { [feature.id]: { stage, at: new Date().toISOString(), by: req.user?.email ?? '' } } });
      audit.record({
        type: 'system',
        outcome: 'changed',
        reason: stage === 'final' ? `“${feature.name}” made final: no longer Beta, for everyone holding its permission.` : `“${feature.name}” put back in Beta.`,
        actor: { kind: 'user', user: req.user?.email ?? '' },
        details: { feature: feature.id, from: before, to: stage },
      });
      scheduler.sync();
    }
    const settings = settingsStore.get();
    res.json({ features: featureList(settings).filter((f) => !featureLocked(f)).map(({ unlockedBy, ...f }) => ({ ...f, canUse: mayUse(settings, f.id, req.permissions) })), canManage: true });
  });

  /**
   * The Cx Credits Calculator (Settings → Beta features): an Admin's switch and the address. The calculator runs on
   * its own, with its own sign-in; CxMissionZero only sends people there. Turned on, the menu shows Cx Credits
   * Calculator to the roles that may use it and opens that address; turned off (as a new server is), the menu has no
   * calculator. The built-in one is muted unless the server was started with CALCULATOR_BUILTIN=on (src/server.js).
   */
  app.get('/api/calculator/address', requirePermission('features.manage'), (req, res) => {
    res.json({ calculator: settingsStore.get().calculator, builtIn: calculatorBuiltIn() });
  });

  app.put('/api/calculator/address', requirePermission('features.manage'), asyncRoute(async (req, res) => {
    const before = settingsStore.get().calculator;
    const incoming = {};
    if (req.body && 'url' in req.body) incoming.url = req.body.url;
    if (req.body && 'external' in req.body) incoming.external = req.body.external === true;
    const after = settingsStore.save({ calculator: incoming }).calculator;
    if (before.external !== after.external || before.url !== after.url) {
      const off = calculatorBuiltIn() ? 'The Cx Credits Calculator opens in CxMissionZero again (the built-in page).' : 'The Cx Credits Calculator was turned off: the menu no longer shows it.';
      audit.record({
        type: 'system',
        outcome: 'changed',
        reason: after.external ? `The Cx Credits Calculator was turned on: the menu opens ${after.url}.` : before.external ? off : `The Cx Credits Calculator's address was ${after.url ? `set to ${after.url}` : 'cleared'} (not turned on).`,
        actor: { kind: 'user', user: req.user?.email ?? '' },
        details: { calculator: { before, after } },
      });
    }
    res.json({ calculator: after, builtIn: calculatorBuiltIn() });
  }));

  /**
   * /calculator, typed or kept as a bookmark: sent on to the address an Admin gave, for someone signed in who may
   * use the calculator. Anyone else, or with the calculator off, lands on CxMissionZero's own page. (The address is
   * told to nobody who is not signed in, and the calculator is not told where its visitor came from.)
   */
  app.get('/calculator', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (!currentSession(req)) return res.redirect(302, '/');
    next();
  }, requireSession, (req, res) => {
    const { external, url } = settingsStore.get().calculator ?? {};
    res.redirect(302, can(req, 'projections.use') && external && url ? url : '/');
  });
}
