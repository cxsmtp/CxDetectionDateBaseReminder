/*
 * model.js — the analytics behind the calculator.
 *
 * Everything here is a pure function on plain data. That matters twice over:
 * the app calls it directly, and the exported customer report embeds a
 * serialised copy of this same object, so the numbers in the export are
 * produced by exactly the code that produced them on screen. Nothing in this
 * file may close over anything outside it.
 *
 * Vocabulary
 *   open        vulnerabilities in the backlog at the end of a week
 *   fixed       vulnerabilities that left the backlog during a week
 *   introduced  derived: open(t) - open(t-1) + fixed(t)
 *   credit      one Checkmarx credit: 1 per triage, 3 per remediation by default
 *
 * The plan is deliberately simple. For each severity the customer sets two
 * numbers and nothing else:
 *
 *   selected  how many of the open findings to put through triage (0 .. open)
 *   fp        the share of those expected to come back false positive
 *
 * Everything selected is triaged. The true positives — selected x (100 - fp) —
 * are then remediated. False positives cost their triage credit and stop there.
 */
window.CxModel = {
  SEVERITIES: ['Critical', 'High', 'Medium', 'Low', 'Info'],

  /* Assumptions the team can override before exporting. The false-positive
   * defaults are typical AppSec figures, not measured values — replace them
   * with real triage history as soon as there is any. */
  DEFAULTS: {
    triageCredits: 1,
    remediationCredits: 3,
    falsePositive: { Critical: 15, High: 25, Medium: 40, Low: 60, Info: 90 },
    windowMonths: 3,
    horizonMonths: 12,
  },

  /* A month is not a whole number of weeks, and the exports are weekly. */
  WEEKS_PER_MONTH: 4.345,

  monthsToWeeks(months) {
    return Math.max(1, Math.round(months * CxModel.WEEKS_PER_MONTH));
  },

  /* ------------------------------------------------------------- utilities -- */

  sum(list) {
    let total = 0;
    for (const v of list) if (typeof v === 'number' && isFinite(v)) total += v;
    return total;
  },

  mean(list) {
    const usable = list.filter((v) => typeof v === 'number' && isFinite(v));
    return usable.length ? CxModel.sum(usable) / usable.length : 0;
  },

  clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  },

  emptyBySeverity(value) {
    const out = {};
    for (const s of CxModel.SEVERITIES) out[s] = typeof value === 'function' ? value(s) : value;
    return out;
  },

  addWeeks(isoDate, weeks) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const shifted = new Date(Date.UTC(y, m - 1, d + weeks * 7));
    const pad = (n) => String(n).padStart(2, '0');
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  },

  /* --------------------------------------------------------------- framing -- */

  /**
   * Align the two exports onto one weekly timeline and derive the influx.
   * Weeks present in only one file are kept — the missing side stays null so it
   * is visibly absent rather than silently zero.
   */
  align(totals, fixed) {
    const weeks = Array.from(new Set([...(totals?.weeks || []), ...(fixed?.weeks || [])])).sort();
    const valueAt = (series, week, severity) => {
      if (!series) return null;
      const i = series.weeks.indexOf(week);
      return i < 0 ? null : (series.bySeverity[severity][i] ?? 0);
    };

    const open = CxModel.emptyBySeverity(() => []);
    const fixes = CxModel.emptyBySeverity(() => []);
    const introduced = CxModel.emptyBySeverity(() => []);

    for (const week of weeks) {
      for (const s of CxModel.SEVERITIES) {
        open[s].push(valueAt(totals, week, s));
        fixes[s].push(valueAt(fixed, week, s));
      }
    }

    weeks.forEach((_, i) => {
      for (const s of CxModel.SEVERITIES) {
        if (i === 0) { introduced[s].push(null); continue; }
        const before = open[s][i - 1];
        const now = open[s][i];
        const cleared = fixes[s][i];
        introduced[s].push(
          before === null || now === null || cleared === null ? null : now - before + cleared
        );
      }
    });

    return {
      weeks, open, fixed: fixes, introduced,
      missingTotals: weeks.filter((w) => !(totals?.weeks || []).includes(w)),
      missingFixed: weeks.filter((w) => !(fixed?.weeks || []).includes(w)),
    };
  },

  /** Sum a per-severity frame across every severity. */
  rollup(frame) {
    const length = frame[CxModel.SEVERITIES[0]].length;
    const out = [];
    for (let i = 0; i < length; i++) {
      let total = 0;
      let known = false;
      for (const s of CxModel.SEVERITIES) {
        const v = frame[s][i];
        if (v === null || v === undefined) continue;
        total += v;
        known = true;
      }
      out.push(known ? total : null);
    }
    return out;
  },

  /* --------------------------------------------------------------- windows -- */

  /**
   * The timeline choices this dataset can actually support.
   *
   * A window is only offered when there is a real snapshot that far back. The
   * utility this replaces always *labelled* its window "6 months" even when it
   * had silently fallen back to the earliest row it had, which quietly changes
   * what every rate in the matrix means. Here a window that the data cannot
   * cover is not offered at all, and the ones that are carry the real span.
   */
  windowOptions(frames) {
    const weeks = frames.weeks;
    const span = weeks.length - 1;            // usable steps between snapshots
    if (span < 1) return [];

    const options = [{ weeks: 1, months: null, label: 'Since last week', short: 'last week' }];
    for (const months of [1, 3, 6, 9, 12, 18, 24]) {
      const w = CxModel.monthsToWeeks(months);
      if (w > span) break;
      const name = months === 1 ? '1 month' : `${months} months`;
      options.push({ weeks: w, months, label: name, short: name });
    }
    if (!options.some((o) => o.weeks === span)) {
      options.push({
        weeks: span,
        months: null,
        label: `All data (${span + 1} weeks)`,
        short: `all ${span + 1} weeks`,
      });
    }
    return options;
  },

  /** Snap a requested window to the closest one this dataset can support. */
  resolveWindow(frames, requestedWeeks) {
    const options = CxModel.windowOptions(frames);
    if (!options.length) return null;
    let best = options[0];
    for (const option of options) {
      if (Math.abs(option.weeks - requestedWeeks) < Math.abs(best.weeks - requestedWeeks)) best = option;
    }
    return best;
  },

  /* ---------------------------------------------------------------- stats -- */

  /**
   * Every rate the report quotes, over one chosen window.
   *
   * The window runs from a real snapshot (`prior`) to the latest one, and
   * every ratio is stated against a base that is named, because the utility
   * this replaces got exactly that wrong: it divided the debt increase by the
   * OPENING backlog and the fix rate by the CLOSING one, then printed them as
   * adjacent rows, which invites a subtraction that means nothing. Here:
   *
   *   debtIncrease  (current - prior) / prior      change in the backlog
   *   clearedShare  fixedInWindow / prior          how much of it was cleared
   *   keepUp        fixedInWindow / introduced     arrivals actually kept up with
   *
   * The first two share a base and can be read together. The third is the only
   * one that answers "are we keeping up", and it is the only one with arrivals
   * in the denominator.
   */
  stats(frames, windowWeeks) {
    const weeks = frames.weeks;
    const last = weeks.length - 1;
    const span = Math.max(1, Math.min(windowWeeks || CxModel.monthsToWeeks(CxModel.DEFAULTS.windowMonths), last));
    const from = Math.max(0, last - span);
    const steps = last - from;

    const bySeverity = {};
    for (const s of CxModel.SEVERITIES) {
      const current = frames.open[s][last] ?? 0;
      const prior = frames.open[s][from] ?? 0;
      const introduced = CxModel.sum(frames.introduced[s].slice(from + 1, last + 1));
      const fixed = CxModel.sum(frames.fixed[s].slice(from + 1, last + 1));
      bySeverity[s] = {
        severity: s,
        backlog: current,
        prior,
        introduced,
        fixed,
        change: current - prior,
        debtIncrease: prior > 0 ? (current - prior) / prior : null,
        clearedShare: prior > 0 ? fixed / prior : null,
        keepUp: introduced > 0 ? fixed / introduced : (fixed > 0 ? 1 : null),
        debtRate: steps > 0 ? introduced / steps : 0,
        fixRate: steps > 0 ? fixed / steps : 0,
        netWeekly: steps > 0 ? (introduced - fixed) / steps : 0,
      };
    }

    const roll = (key) => CxModel.sum(CxModel.SEVERITIES.map((s) => bySeverity[s][key]));
    const backlog = roll('backlog');
    const prior = roll('prior');
    const introduced = roll('introduced');
    const fixed = roll('fixed');

    return {
      bySeverity,
      weeksOfData: weeks.length,
      windowWeeks: steps,
      firstWeek: weeks[0],
      windowStart: weeks[from],
      lastWeek: weeks[last],
      total: {
        backlog,
        prior,
        introduced,
        fixed,
        change: backlog - prior,
        debtIncrease: prior > 0 ? (backlog - prior) / prior : null,
        clearedShare: prior > 0 ? fixed / prior : null,
        keepUp: introduced > 0 ? fixed / introduced : (fixed > 0 ? 1 : null),
        debtRate: steps > 0 ? introduced / steps : 0,
        fixRate: steps > 0 ? fixed / steps : 0,
        netWeekly: steps > 0 ? (introduced - fixed) / steps : 0,
      },
    };
  },

  /* ----------------------------------------------------------------- plan -- */

  /** A starting plan: triage the whole backlog, at the default FP rates. */
  defaultPlan(stats, assumptions) {
    const plan = {};
    for (const s of CxModel.SEVERITIES) {
      plan[s] = {
        selected: Math.round(stats.bySeverity[s].backlog),
        fp: assumptions.falsePositive[s] ?? 0,
      };
    }
    return plan;
  },

  /** Keep a plan inside the backlog it is drawn from. */
  clampPlan(plan, stats) {
    const out = {};
    for (const s of CxModel.SEVERITIES) {
      const backlog = Math.round(stats.bySeverity[s].backlog);
      const row = plan[s] || { selected: 0, fp: 0 };
      out[s] = {
        selected: Math.round(CxModel.clamp(row.selected || 0, 0, backlog)),
        fp: Math.round(CxModel.clamp(row.fp || 0, 0, 100)),
      };
    }
    return out;
  },

  /* ----------------------------------------------------------------- cost -- */

  /**
   * The whole cost model, in six lines per severity:
   *
   *   triage       = selected x triageCredits
   *   truePositive = selected x (100 - fp) / 100
   *   remediation  = truePositive x remediationCredits
   *   total        = triage + remediation
   */
  cost(plan, stats, assumptions) {
    const rows = [];
    let count = 0;
    let truePositives = 0;
    let triage = 0;
    let remediation = 0;

    for (const s of CxModel.SEVERITIES) {
      const row = plan[s] || { selected: 0, fp: 0 };
      const backlog = Math.round(stats.bySeverity[s].backlog);
      const selected = Math.round(CxModel.clamp(row.selected || 0, 0, backlog));
      const fp = CxModel.clamp(row.fp || 0, 0, 100);
      const tpRate = (100 - fp) / 100;
      const tp = selected * tpRate;
      const triageCost = selected * assumptions.triageCredits;
      const remedCost = tp * assumptions.remediationCredits;

      rows.push({
        severity: s,
        backlog,
        selected,
        share: backlog > 0 ? selected / backlog : 0,
        fp,
        tpRate,
        truePositives: tp,
        falsePositives: selected - tp,
        triage: triageCost,
        remediation: remedCost,
        total: triageCost + remedCost,
        creditsEach: selected > 0 ? (triageCost + remedCost) / selected : 0,
        deferred: backlog - selected,
        /* What today's backlog drops to once this plan is worked through.
         * Both true and false positives leave: the false ones are dispositioned,
         * the real ones are fixed. It is a reduction of TODAY's backlog, not a
         * backlog at a future date — arrivals are handled by the forecast. */
        backlogAfter: backlog - selected,
      });

      count += selected;
      truePositives += tp;
      triage += triageCost;
      remediation += remedCost;
    }

    return {
      rows,
      bySeverity: rows.reduce((acc, r) => { acc[r.severity] = r; return acc; }, {}),
      count,
      truePositives,
      falsePositives: count - truePositives,
      triage,
      remediation,
      total: triage + remediation,
      creditsEach: count > 0 ? (triage + remediation) / count : 0,
      backlog: CxModel.sum(rows.map((r) => r.backlog)),
      deferred: CxModel.sum(rows.map((r) => r.deferred)),
      backlogAfter: CxModel.sum(rows.map((r) => r.backlogAfter)),
    };
  },

  /* ------------------------------------------------------------- forecast -- */

  /**
   * Two futures on one axis, both in open findings:
   *
   *   noAction  the backlog keeps taking the measured weekly arrivals
   *   withPlan  the same arrivals, minus the selected work as it is cleared at
   *             `pace` findings a week
   *
   * Arrivals do not stop because a plan started, so the two lines converge in
   * slope once the plan is finished. That gap is the point of the chart.
   */
  forecast(options) {
    const { backlog, debtRate, selected, pace, horizonWeeks, startWeek } = options;
    const arrivals = Math.max(0, debtRate);
    const weekly = Math.max(0, pace);
    const scope = Math.max(0, selected);

    const weeks = [{
      week: 0,
      date: startWeek || null,
      noAction: backlog,
      withPlan: backlog,
      cleared: 0,
      credits: 0,
    }];

    let clearedTotal = 0;
    let finishedWeek = null;
    for (let w = 1; w <= horizonWeeks; w++) {
      const clear = Math.min(weekly, Math.max(0, scope - clearedTotal));
      clearedTotal += clear;
      if (finishedWeek === null && clearedTotal >= scope - 0.5) finishedWeek = w;
      weeks.push({
        week: w,
        date: startWeek ? CxModel.addWeeks(startWeek, w) : null,
        noAction: backlog + arrivals * w,
        withPlan: Math.max(0, backlog + arrivals * w - clearedTotal),
        cleared: clearedTotal,
        weekCleared: clear,
      });
    }

    const last = weeks[weeks.length - 1];
    return {
      weeks,
      arrivals,
      pace: weekly,
      scope,
      weeksToFinishPlan: weekly > 0 ? scope / weekly : null,
      finishedWeek,
      netBurn: weekly - arrivals,
      weeksToZero: weekly > arrivals ? backlog / (weekly - arrivals) : null,
      paceToHold: arrivals,
      endNoAction: last.noAction,
      endWithPlan: last.withPlan,
      avoided: last.noAction - last.withPlan,
    };
  },

  /** Findings a week needed to clear `backlog` in `weeks`, arrivals included. */
  paceFor(backlog, debtRate, weeks) {
    if (!weeks || weeks <= 0) return Infinity;
    return backlog / weeks + Math.max(0, debtRate);
  },

  /* ----------------------------------------------------------- formatting -- */

  int(value) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    return Math.round(value).toLocaleString('en-US');
  },

  compact(value) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs >= 1e9) return (value / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B';
    if (abs >= 1e6) return (value / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M';
    if (abs >= 1e4) return (value / 1e3).toFixed(0) + 'k';
    if (abs >= 1e3) return (value / 1e3).toFixed(1) + 'k';
    return Math.round(value).toLocaleString('en-US');
  },

  signed(value) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    const rounded = Math.round(value);
    return (rounded > 0 ? '+' : '') + rounded.toLocaleString('en-US');
  },

  pct(value, digits) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    return (value * 100).toFixed(digits === undefined ? 0 : digits) + '%';
  },

  weeksAsDuration(weeks) {
    if (weeks === null || weeks === undefined || !isFinite(weeks)) return 'not at this pace';
    if (weeks <= 0) return 'already clear';
    if (weeks < 9) return `${Math.ceil(weeks)} weeks`;
    if (weeks < 105) return `${Math.round(weeks)} weeks (~${(weeks / 52).toFixed(1)} years)`;
    return `${(weeks / 52).toFixed(1)} years`;
  },
};
