// Cx Credits Calculator: the levers a projection report carries, so the customer can try other numbers
// in the file itself, with no connection to Checkmarx One. `leverInputs` is what the report keeps when
// it is made (page.js); `leverData` works the report's figures out again from it, with the same model
// the calculator uses, so the report as sent and the report worked out again agree to the last digit.
//
// Without project details (the person making the report unticked them) no project's name is kept:
// projects that work out alike (scan frequency, criticality, what was set for them) are kept as one
// row of their count and their 10K units, which gives the same credits as the projects one by one.

import { SEVERITIES, creditSummary, fusionEstimate, fusionImpact, impactSettings, linesOf, overallImpact, planForecast, severityPlan, trImpact, trProjection, unitsOf, wholeNumber } from './model.js';

const debtFigures = (x) => ({ current: x.current, prior: x.prior, fixed: x.fixed, arrivals: x.arrivals, debtRate: x.debtRate, fixRate: x.fixRate, fixedMonthly: x.fixedMonthly, netMonthly: x.netMonthly, addedPct: x.addedPct, fixedPct: x.fixedPct });

/** The debt and fixing rates over the last 6 months, as the report shows them. */
export function recentRates(recent) {
  if (!recent) return null;
  return {
    months: 6,
    spanMonths: recent.spanMonths,
    ...Object.fromEntries([...SEVERITIES, 'total'].map((s) => {
      const x = s === 'total' ? recent.total : recent.perSeverity[s];
      return [s, { arrivals: x.arrivals, fixedMonthly: x.fixedMonthly, addedPct: x.addedPct, fixedPct: x.fixedPct }];
    })),
  };
}

/** The triage & remediation part of a report's data: the projection, the debt it starts from, and its charts. */
export function trReport(analysis, projection, { recent = null, weekly = null } = {}) {
  return {
    asOf: analysis.latestDate,
    previousDate: analysis.previousDate,
    lookbackMonths: analysis.lookbackMonths,
    months: projection.months,
    paced: projection.paced,
    fusion: projection.fusion,
    sastOnly: projection.sastOnly,
    ahead: projection.ahead,
    rows: projection.rows,
    totals: projection.totals,
    analysis: {
      ...Object.fromEntries(SEVERITIES.map((s) => [s, debtFigures(analysis.perSeverity[s])])),
      total: debtFigures(analysis.total),
      spanMonths: analysis.spanMonths,
    },
    recent,
    monthlyChange: analysis.monthlyChange,
    history: analysis.history.map((h) => ({ month: h.month })),
    weekly,
    forecast: planForecast(analysis, projection),
    bySeverity: severityPlan(analysis, projection),
  };
}

/** The Fusion part of a report's data. Without details its rows are not kept (they would name the projects). */
export function fusionReport(est, { remainingCredits = null, details = true } = {}) {
  return {
    periodMonths: est.settings.periodMonths,
    defaultScans: est.settings.defaultScans,
    defaultModel: est.settings.defaultModel,
    models: est.settings.models,
    rules: est.settings.byFrequency,
    byFrequency: est.byFrequency,
    byModel: est.byModel,
    totals: est.totals,
    remainingCredits,
    details,
    rows: details ? est.rows.map((r) => ({ key: r.key, name: r.name, included: r.included, criticality: r.criticality, frequency: r.frequency, scansPerWeek: r.scansPerWeek, lines: r.lines, units: r.units, scans: r.scans, scansFrom: r.scansFrom, model: r.model, credits: r.credits })) : [],
  };
}

/** Projects with nothing that tells them apart for Fusion, as one row each: no name, no id. */
export function foldProjects(projects = []) {
  const groups = new Map();
  for (const p of projects) {
    const scansOverride = wholeNumber(p.scansOverride);
    const modelOverride = p.modelOverride || null;
    const at = [p.included !== false, p.frequency ?? null, p.criticality ?? null, scansOverride, modelOverride].join('|');
    const g = groups.get(at) ?? { included: p.included !== false, frequency: p.frequency ?? null, criticality: p.criticality ?? null, scansOverride, modelOverride, count: 0, units: 0, loc: 0 };
    const lines = linesOf(p) ?? 0;
    g.count += 1;
    g.units += unitsOf(lines);
    g.loc += lines;
    groups.set(at, g);
  }
  return [...groups.values()];
}

/** Fusion for new code (cloc-fusion, git, cloc): its rows for the impact only, folded by scans when details are left out. */
const newCodeRows = (rows = [], details = true) => {
  const kept = rows.filter((r) => r.included && r.units);
  if (details) return kept.map((r) => ({ included: true, lines: r.lines, units: r.units, scans: r.scans }));
  const byScans = new Map();
  for (const r of kept) {
    const g = byScans.get(r.scans) ?? { included: true, lines: 0, units: 0, scans: r.scans };
    g.lines += r.lines;
    g.units += r.units;
    byScans.set(r.scans, g);
  }
  return [...byScans.values()];
};

/**
 * What a report keeps to be worked out again: the backlog's analysis (and SAST's part of it), the
 * plan, the Fusion settings and projects (folded without details), the totals and the impact's assumptions.
 */
export function leverInputs({ analysis = null, sast = null, plan = {}, months = 12, fusionOn = false, recent = null, weekly = null, fusion = null, fusionNewRows = null, totals = {}, impact = null, details = true }) {
  const sastPart = sast ? { perSeverity: Object.fromEntries(SEVERITIES.map((s) => [s, { current: sast.perSeverity[s].current, arrivals: sast.perSeverity[s].arrivals }])) } : null;
  return {
    version: 1,
    details: details !== false,
    months,
    tr: analysis
      ? {
          analysis,
          sast: sastPart,
          fusion: Boolean(fusionOn),
          recent,
          weekly,
          plan: {
            selected: Object.fromEntries(SEVERITIES.map((s) => [s, plan.selected?.[s] ?? null])),
            fpPercent: { ...plan.fpPercent },
            triageCost: { ...plan.triageCost },
            remediationCost: { ...plan.remediationCost },
            includeFuture: plan.includeFuture,
            aiDeclinePercent: plan.aiDeclinePercent,
            fusionUpliftPercent: plan.fusionUpliftPercent,
          },
        }
      : null,
    fusion: fusion
      ? {
          settings: fusion.settings,
          remainingCredits: fusion.remainingCredits ?? null,
          projects: details !== false ? fusion.projects.map((p, key) => ({ key, name: p.name, included: p.included !== false, criticality: p.criticality ?? null, frequency: p.frequency ?? null, scansPerWeek: p.scansPerWeek ?? null, loc: linesOf(p), scansOverride: wholeNumber(p.scansOverride), modelOverride: p.modelOverride || null })) : foldProjects(fusion.projects),
        }
      : null,
    fusionNewRows: fusionNewRows ? newCodeRows(fusionNewRows, details !== false) : null,
    totals: { extraPercent: totals.extraPercent ?? 0, bundleCredits: totals.bundleCredits ?? null },
    impact,
  };
}

/** The report's data worked out again from its levers: `sent` keeps what does not move (customer, source, new code). */
export function leverData(sent, inputs) {
  const tr = inputs.tr ? trProjection(inputs.tr.analysis, inputs.tr.plan, { months: inputs.months, fusion: inputs.tr.fusion, sast: inputs.tr.sast }) : null;
  const est = inputs.fusion ? fusionEstimate(inputs.fusion.projects, { ...inputs.fusion.settings, periodMonths: inputs.months }) : null;
  const fusion = est ? fusionReport(est, { remainingCredits: inputs.fusion.remainingCredits, details: inputs.details }) : null;
  const fusionCredits = [fusion?.totals.credits, sent.fusionNew?.totals?.credits].some(Number.isFinite) ? (fusion?.totals.credits ?? 0) + (sent.fusionNew?.totals?.credits ?? 0) : null;
  const impact = (() => {
    if (!inputs.impact) return null;
    const settings = impactSettings(inputs.impact);
    const trI = tr ? trImpact(tr.rows, tr.months, settings) : null;
    const rows = [...(est?.rows.filter((r) => r.included && r.units).map((r) => ({ included: true, lines: r.lines ?? 0, units: r.units, scans: r.scans })) ?? []), ...(inputs.fusionNewRows ?? [])];
    const fuI = rows.length ? fusionImpact(rows, fusionCredits ?? 0, est?.settings.periodMonths ?? inputs.months, settings, tr?.rows ?? null) : null;
    return trI || fuI ? { tr: trI, fusion: fuI, overall: overallImpact(trI, fuI) } : null;
  })();
  return {
    ...sent,
    months: inputs.months,
    summary: creditSummary(tr ? tr.totals.credits : null, fusionCredits, inputs.totals),
    tr: tr ? trReport(inputs.tr.analysis, tr, { recent: inputs.tr.recent, weekly: inputs.tr.weekly }) : sent.tr ?? null,
    fusion: fusion ?? sent.fusion ?? null,
    impact: sent.impact ? impact : null,
  };
}

/** A new projection period: Fusion scans go with it (a project scanned 6 times in 12 months, 12 times in 24). */
export function changePeriod(inputs, months) {
  const to = Math.min(60, Math.max(1, wholeNumber(months) ?? 12));
  const from = inputs.months || 12;
  if (to === from) return inputs;
  const scale = (n) => (n === null || n === undefined ? n : Math.max(n ? 1 : 0, Math.ceil((n * to) / from - 1e-9)));
  const f = inputs.fusion;
  const fusion = f
    ? {
        ...f,
        settings: {
          ...f.settings,
          defaultScans: scale(f.settings.defaultScans),
          byFrequency: Object.fromEntries(Object.entries(f.settings.byFrequency ?? {}).map(([id, r]) => [id, { ...r, scans: scale(r.scans) }])),
          byCriticality: Object.fromEntries(Object.entries(f.settings.byCriticality ?? {}).map(([id, r]) => [id, { ...r, scans: scale(r.scans) }])),
        },
        projects: f.projects.map((p) => ({ ...p, scansOverride: scale(p.scansOverride) })),
      }
    : null;
  return { ...inputs, months: to, fusion };
}
