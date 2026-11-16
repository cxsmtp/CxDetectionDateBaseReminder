/**
 * Settings → Beta features (src/features.js): every Beta feature with its stage and who may use it, making one
 * final (or Beta again), and the Cx Credits Calculator at an address of its own, which is a switch on the same page.
 */
import { featureById, featureList, isFinal, mayUse } from '../features.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerFeatureRoutes(app, d) {
  const { settingsStore, audit, scheduler, asyncRoute, requireSession, can, requirePermission, featureLocked } = d;

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
   * The Cx Credits Calculator at an address of its own (Settings → Beta features): an Admin's switch and the address.
   * Turned on, the menu opens the calculator there and the built-in page is put away; its saved customers and reports
   * stay, and come back when it is turned off.
   */
  app.get('/api/calculator/address', requirePermission('features.manage'), (req, res) => {
    res.json({ calculator: settingsStore.get().calculator });
  });

  app.put('/api/calculator/address', requirePermission('features.manage'), asyncRoute(async (req, res) => {
    const before = settingsStore.get().calculator;
    const incoming = {};
    if (req.body && 'url' in req.body) incoming.url = req.body.url;
    if (req.body && 'external' in req.body) incoming.external = req.body.external === true;
    const after = settingsStore.save({ calculator: incoming }).calculator;
    if (before.external !== after.external || before.url !== after.url) {
      audit.record({
        type: 'system',
        outcome: 'changed',
        reason: after.external ? `The Cx Credits Calculator now opens at its own address, ${after.url}.` : before.external ? 'The Cx Credits Calculator opens in CxMissionZero again (the built-in page).' : `The Cx Credits Calculator's own address was ${after.url ? `set to ${after.url}` : 'cleared'} (not turned on).`,
        actor: { kind: 'user', user: req.user?.email ?? '' },
        details: { calculator: { before, after } },
      });
    }
    res.json({ calculator: after });
  }));
}
