/*
 * report.js — builds the interactive customer report as one self-contained
 * HTML file.
 *
 * The report is not a screenshot of the app. It embeds the weekly data plus a
 * serialised copy of CxModel and CxCharts, so the customer can move two
 * sliders per severity — how many findings to put through triage, and how many
 * of those they expect to come back false positive — and every number, table
 * and chart recomputes with exactly the code that produced the figures on
 * screen.
 *
 * What the customer CANNOT change is the rate card: credits per triage and
 * credits per remediation arrive baked in and are rendered read-only. The
 * scope is negotiable; the price of a unit of work is not.
 *
 * No network, no libraries: the file opens from disk and prints straight to PDF.
 */
window.CxReport = {

  /**
   * Emit a plain object of pure functions as JavaScript source.
   * Methods keep their shorthand form, which is valid inside an object literal;
   * data properties go through JSON. This is why model.js and charts.js are
   * written as self-referential objects with no closure state.
   */
  serialise(name, object) {
    const parts = Object.keys(object).map((key) => {
      const value = object[key];
      if (typeof value === 'function') return value.toString();
      return `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    });
    return `window.${name} = {\n${parts.join(',\n')}\n};`;
  },

  /* Guard against a customer name or filename closing the script block early. */
  json(value) {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  },

  /* ------------------------------------------------------------------ css -- */

  css() {
    return `
:root{color-scheme:light;
--brand:#6B34FC;--brand-strong:#121185;--brand-tint:#EFEDFF;--brand-ink:#FFFFFF;
--page:#F6F5FB;--surface:#FFFFFF;--surface-2:#F3F1FD;
--ink:#0D0B1F;--ink-2:#4A4763;--muted:#78748F;
--grid:#E7E4F3;--axis:#CFCAE4;--border:rgba(13,11,31,.10);--border-strong:rgba(13,11,31,.18);
--good:#0B7A4B;--warn:#A96B00;--bad:#B3261E;
--shadow:0 1px 2px rgba(13,11,31,.06),0 8px 24px rgba(13,11,31,.06);
--font:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;
--brand:#9480EB;--brand-strong:#B9A9FF;--brand-tint:#1C1940;--brand-ink:#0B0A1C;
--page:#08081A;--surface:#111129;--surface-2:#171734;
--ink:#FFFFFF;--ink-2:#C8C4E0;--muted:#948FB4;
--grid:#22224A;--axis:#33325C;--border:rgba(255,255,255,.10);--border-strong:rgba(255,255,255,.20);
--good:#35C88A;--warn:#E0A73A;--bad:#FF7B7B;
--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)}}
:root[data-theme="dark"]{color-scheme:dark;
--brand:#9480EB;--brand-strong:#B9A9FF;--brand-tint:#1C1940;--brand-ink:#0B0A1C;
--page:#08081A;--surface:#111129;--surface-2:#171734;
--ink:#FFFFFF;--ink-2:#C8C4E0;--muted:#948FB4;
--grid:#22224A;--axis:#33325C;--border:rgba(255,255,255,.10);--border-strong:rgba(255,255,255,.20);
--good:#35C88A;--warn:#E0A73A;--bad:#FF7B7B;
--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font-family:var(--font);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.page{max-width:1060px;margin:0 auto;padding:28px 22px 70px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em}
h2{font-size:17px;margin:0;font-weight:650;letter-spacing:-.01em}
h3{font-size:14px;margin:0 0 6px;font-weight:650}
p{margin:0 0 10px}
.masthead{display:flex;align-items:flex-start;gap:18px;border-bottom:2px solid var(--brand);padding-bottom:18px;margin-bottom:22px}
.masthead .logo{flex:none}
.masthead .logo img{height:34px;width:auto;display:block}
.masthead .meta{margin-left:auto;text-align:right;font-size:12.5px;color:var(--muted);white-space:nowrap}
.masthead .customer{font-size:13px;font-weight:650;color:var(--brand);letter-spacing:.04em;text-transform:uppercase}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);padding:18px;margin-bottom:18px}
.card>header{display:flex;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.card>header .sub{font-size:12.5px;color:var(--muted)}
.section-title{font-size:12px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:26px 0 12px}
.grid{display:grid;gap:14px}
.grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.grid.four{grid-template-columns:repeat(4,minmax(0,1fr))}
@media (max-width:900px){.grid.two,.grid.three,.grid.four{grid-template-columns:minmax(0,1fr)}}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px}
.kpi .label{font-size:12px;color:var(--muted);font-weight:550}
.kpi .value{font-size:28px;font-weight:680;letter-spacing:-.02em;margin-top:2px}
.kpi .value.small{font-size:21px}
.kpi .note{font-size:12px;color:var(--ink-2);margin-top:2px}
.kpi.accent{background:var(--brand-tint);border-color:color-mix(in srgb,var(--brand) 35%,transparent)}
.kpi.accent .value{color:var(--brand)}
.kpi.good .value{color:var(--good)}
.kpi.bad .value{color:var(--bad)}
.headline{font-size:15px;line-height:1.6;color:var(--ink-2)}
.headline b,.headline strong{color:var(--ink);font-weight:650}
.callout{border-left:3px solid var(--brand);background:var(--surface-2);border-radius:0 9px 9px 0;padding:11px 14px;font-size:13px}
.callout.warn{border-left-color:var(--warn)}
.callout.good{border-left-color:var(--good)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:right;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;font-variant-numeric:tabular-nums}
th:first-child,td:first-child{text-align:left;font-variant-numeric:normal}
thead th{font-size:11.5px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border-bottom-color:var(--border-strong)}
tfoot td{font-weight:650;border-top:1px solid var(--border-strong);border-bottom:none}
.table-scroll{overflow-x:auto}
details{border-top:1px solid var(--border);margin-top:14px;padding-top:10px}
summary{cursor:pointer;font-size:12.5px;color:var(--muted);font-weight:550}
.sev-dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:7px}
.hint{font-size:12px;color:var(--muted)}
.locked{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:650;color:var(--brand);background:var(--brand-tint);border-radius:999px;padding:2px 9px;white-space:nowrap}
.sev-grid{display:grid;gap:12px;grid-template-columns:repeat(5,minmax(0,1fr))}
@media (max-width:1000px){.sev-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.sev-grid{grid-template-columns:minmax(0,1fr)}}
.sev-box{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:12px}
.sev-head{display:flex;align-items:center;gap:2px;font-size:13px;font-weight:650;margin-bottom:10px;flex-wrap:wrap}
.sev-open{margin-left:auto;font-size:11.5px;font-weight:550;color:var(--muted);white-space:nowrap}
.slider-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:12px;color:var(--muted);margin-top:8px}
.slider-row output{font-size:13px;font-weight:650;color:var(--ink);font-variant-numeric:tabular-nums}
.sev-foot{margin:10px 0 0;padding-top:9px;border-top:2px solid var(--border);font-size:11.5px;color:var(--ink-2)}
.plan-tools{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:end;margin-top:16px}
@media (max-width:760px){.plan-tools{grid-template-columns:minmax(0,1fr)}}
.plan-buttons{display:flex;flex-wrap:wrap;gap:8px}
.field{display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--muted)}
.field output{font-weight:650;color:var(--ink);font-variant-numeric:tabular-nums}
button.plain{font:inherit;font-size:12.5px;font-weight:550;border-radius:9px;border:1px solid var(--border-strong);background:var(--surface);color:var(--ink);padding:6px 12px;cursor:pointer}
button.plain:hover{background:var(--surface-2)}
button.accent{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
input[type=range]{width:100%;accent-color:var(--brand);margin:0}
.chart-wrap{width:100%;overflow-x:auto}
.cx-chart{width:100%;height:auto;display:block;min-width:520px}
.cx-grid{stroke:var(--grid);stroke-width:1}
.cx-axis{stroke:var(--axis);stroke-width:1}
.cx-tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.cx-endlabel{font-size:11.5px;font-weight:600}
.cx-crosshair{stroke:var(--brand);stroke-width:1;pointer-events:none}
.cx-hit{fill:transparent}
.cx-empty{color:var(--muted);font-size:13px;padding:12px 0}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font-size:12.5px;color:var(--ink-2)}
.legend .item{display:inline-flex;align-items:center;gap:6px}
.legend .swatch{width:11px;height:11px;border-radius:3px;flex:none}
.legend .swatch.line{height:3px;border-radius:2px;width:15px}
.cx-tooltip{position:fixed;z-index:100;pointer-events:none;opacity:0;transition:opacity 90ms ease;background:var(--surface);color:var(--ink);border:1px solid var(--border-strong);border-radius:10px;box-shadow:var(--shadow);padding:9px 11px;font-size:12.5px;max-width:280px}
.cx-tooltip.is-visible{opacity:1}
.cx-tooltip .t-title{font-weight:650;margin-bottom:4px}
.cx-tooltip .t-row{display:flex;justify-content:space-between;gap:14px}
.cx-tooltip .t-row span:last-child{font-variant-numeric:tabular-nums;font-weight:600}
.cx-tooltip .t-row.t-total{border-top:1px solid var(--border);margin-top:4px;padding-top:4px}
.footnote{margin-top:30px;padding-top:14px;border-top:1px solid var(--border);font-size:11.5px;color:var(--muted)}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.section-head .section-title{margin-bottom:8px}
.chip-row{display:inline-flex;flex-wrap:wrap;border:1px solid var(--border-strong);border-radius:999px;overflow:hidden;background:var(--surface);margin-bottom:8px}
.chip{font:inherit;border:none;border-radius:0;background:transparent;padding:6px 13px;font-size:12.5px;font-weight:550;color:var(--ink-2);white-space:nowrap;cursor:pointer}
.chip+.chip{border-left:1px solid var(--border)}
.chip.is-on{background:var(--brand);color:var(--brand-ink)}
.chip.is-on+.chip{border-left-color:transparent}
.chip-caption{font-size:12px;color:var(--muted);margin:-2px 0 12px}
.matrix td:first-child{font-weight:550}
.matrix .total-col{font-weight:650;background:var(--surface-2);border-left:1px solid var(--border)}
.matrix thead th.total-col{color:var(--ink)}
.matrix tr.is-muted td{color:var(--muted)}
.matrix tr.is-highlight td{background:var(--brand-tint)}
.matrix tr.is-total td{border-top:1px solid var(--border-strong);font-size:14px}
.matrix tr.is-total td.total-col{color:var(--brand)}
.sev-head-cell{display:inline-flex;align-items:center;white-space:nowrap}
@media print{
 .no-print{display:none!important}
 body{background:#fff}
 .page{max-width:none;padding:0}
 .card{box-shadow:none;break-inside:avoid}
 .cx-chart{min-width:0}
 input[type=range]{display:none}
 .chip{display:none}
 .chip.is-on{display:inline-block;background:transparent;color:var(--ink);font-weight:650;padding:0}
 .chip-row{border:none;background:transparent;margin:0}
 .slider-row{color:var(--ink-2)}
 details{display:block}
 details>summary{display:none}
 th,td{white-space:normal;padding:6px 7px;font-size:11.5px}
 .table-scroll{overflow:visible}
 .legend{font-size:11px}
}
`;
  },

  /* -------------------------------------------------------------- runtime -- */

  /**
   * The report's own script. Written as a real function so it can use template
   * literals freely; it is serialised with toString() at build time and reads
   * everything it needs from window.REPORT.
   */
  runtime: function () {
    const R = window.REPORT;
    const $ = (id) => document.getElementById(id);
    const SEV = CxModel.SEVERITIES;

    const state = {
      plan: JSON.parse(JSON.stringify(R.plan)),
      pace: R.pace,
      windowWeeks: R.windowWeeks,
      horizonMonths: R.horizonMonths,
    };

    const theme = () => {
      const stamped = document.documentElement.getAttribute('data-theme');
      if (stamped === 'dark' || stamped === 'light') return stamped;
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark' : 'light';
    };
    const colors = () => R.palette.severity[theme()];
    const flowColors = () => R.palette.flow[theme()];
    const scenarioColors = () => R.palette.scenario[theme()];
    const dot = (severity) => `<span class="sev-dot" style="background:${colors()[severity]}"></span>`;

    const windowOptions = CxModel.windowOptions(R.frames);
    let stats = null;
    let cost = null;
    let forecast = null;

    /* Short form of the chosen window, for use inside a table label. */
    const windowName = () => {
      const match = windowOptions.find((o) => o.weeks === state.windowWeeks);
      return match ? match.short : `${state.windowWeeks} weeks`;
    };

    /* --------------------------------------------------------- timelines -- */

    function renderWindowChips() {
      $('window-chips').innerHTML = windowOptions.map((o) =>
        `<button type="button" class="chip ${o.weeks === state.windowWeeks ? 'is-on' : ''}" ` +
        `data-window="${o.weeks}" aria-pressed="${o.weeks === state.windowWeeks}">${o.label}</button>`).join('');
      $('window-chips').querySelectorAll('button[data-window]').forEach((button) => {
        button.addEventListener('click', () => {
          state.windowWeeks = Number(button.dataset.window);
          computeWindow();
        });
      });
      $('window-caption').textContent =
        `Rates measured from ${stats.windowStart} to ${stats.lastWeek} — ` +
        `${stats.windowWeeks} week${stats.windowWeeks === 1 ? '' : 's'} of movement. ` +
        `${R.frames.weeks.length} weekly snapshots available in total.`;
    }

    function renderHorizonChips() {
      $('horizon-chips').innerHTML = [3, 6, 9, 12, 18, 24].map((m) =>
        `<button type="button" class="chip ${m === state.horizonMonths ? 'is-on' : ''}" ` +
        `data-horizon="${m}" aria-pressed="${m === state.horizonMonths}">${m} months</button>`).join('');
      $('horizon-chips').querySelectorAll('button[data-horizon]').forEach((button) => {
        button.addEventListener('click', () => {
          state.horizonMonths = Number(button.dataset.horizon);
          renderHorizonChips();
          compute();
        });
      });
    }

    /* ------------------------------------------------------------- top -- */

    function renderKpis() {
      const t = stats.total;
      const losing = t.change > 0;
      $('kpis').innerHTML = `
        <div class="kpi accent">
          <div class="label">Open findings</div>
          <div class="value">${CxModel.compact(t.backlog)}</div>
          <div class="note">${CxModel.int(t.backlog)} as of ${stats.lastWeek}</div>
        </div>
        <div class="kpi ${losing ? 'bad' : 'good'}">
          <div class="label">Debt increase</div>
          <div class="value">${CxModel.pct(t.debtIncrease, 1)}</div>
          <div class="note">${CxModel.signed(t.change)} findings since ${stats.windowStart}</div>
        </div>
        <div class="kpi good">
          <div class="label">Cleared</div>
          <div class="value">${CxModel.pct(t.clearedShare, 1)}</div>
          <div class="note">${CxModel.int(t.fixed)} closed, against the backlog at ${stats.windowStart}</div>
        </div>
        <div class="kpi ${(t.keepUp || 0) >= 1 ? 'good' : 'bad'}">
          <div class="label">Kept up with</div>
          <div class="value">${CxModel.pct(t.keepUp)}</div>
          <div class="note">${CxModel.int(t.fixed)} closed of ${CxModel.int(t.introduced)} that arrived</div>
        </div>`;

      const perHundred = Math.round((t.keepUp || 0) * 100);
      const doubles = t.netWeekly > 0 ? t.backlog / t.netWeekly : null;
      $('headline').innerHTML = t.netWeekly > 0
        ? `For every <strong>100</strong> findings that arrive, the team clears <strong>${perHundred}</strong>. ` +
          `That is <strong>${CxModel.int(t.debtRate)}</strong> in and <strong>${CxModel.int(t.fixRate)}</strong> out ` +
          `a week, so the backlog grows by <strong>${CxModel.int(t.netWeekly)}</strong> a week — at that rate it ` +
          `doubles in about <strong>${CxModel.weeksAsDuration(doubles)}</strong>.`
        : `The team clears <strong>${perHundred}</strong> of every 100 findings that arrive — ` +
          `<strong>${CxModel.int(t.debtRate)}</strong> in against <strong>${CxModel.int(t.fixRate)}</strong> ` +
          'out a week. The backlog is shrinking on its own.';
    }

    /* ------------------------------------------------------------- plan -- */

    function renderSliders() {
      $('sev-grid').innerHTML = SEV.map((s) => {
        const backlog = Math.round(stats.bySeverity[s].backlog);
        const row = state.plan[s];
        return `<div class="sev-box">
          <div class="sev-head">${dot(s)}${s}<span class="sev-open">${CxModel.int(backlog)} open</span></div>
          <div class="slider-row"><span>To triage</span><output data-sel-out="${s}">${CxModel.int(row.selected)}</output></div>
          <input type="range" min="0" max="${backlog}" step="${Math.max(1, Math.round(backlog / 500))}"
                 value="${row.selected}" data-sel="${s}" aria-label="Findings to triage for ${s}">
          <div class="slider-row"><span>Est. false positive %</span><output data-fp-out="${s}">${row.fp}%</output></div>
          <input type="range" min="0" max="100" step="1" value="${row.fp}" data-fp="${s}"
                 aria-label="False-positive rate for ${s}">
          <p class="sev-foot" data-cost-out="${s}"></p>
        </div>`;
      }).join('');

      $('sev-grid').querySelectorAll('input[data-sel]').forEach((slider) => {
        slider.addEventListener('input', () => {
          state.plan[slider.dataset.sel].selected = Number(slider.value);
          $('sev-grid').querySelector(`[data-sel-out="${slider.dataset.sel}"]`).textContent =
            CxModel.int(Number(slider.value));
          compute();
        });
      });
      $('sev-grid').querySelectorAll('input[data-fp]').forEach((slider) => {
        slider.addEventListener('input', () => {
          state.plan[slider.dataset.fp].fp = Number(slider.value);
          $('sev-grid').querySelector(`[data-fp-out="${slider.dataset.fp}"]`).textContent = `${slider.value}%`;
          compute();
        });
      });
    }

    function syncSliders() {
      SEV.forEach((s) => {
        const row = state.plan[s];
        const sel = $('sev-grid').querySelector(`input[data-sel="${s}"]`);
        const fp = $('sev-grid').querySelector(`input[data-fp="${s}"]`);
        if (sel) { sel.value = String(row.selected); $('sev-grid').querySelector(`[data-sel-out="${s}"]`).textContent = CxModel.int(row.selected); }
        if (fp) { fp.value = String(row.fp); $('sev-grid').querySelector(`[data-fp-out="${s}"]`).textContent = `${row.fp}%`; }
      });
    }

    function setPlan(mutate) {
      SEV.forEach((s) => mutate(s, state.plan[s], Math.round(stats.bySeverity[s].backlog)));
      state.plan = CxModel.clampPlan(state.plan, stats);
      syncSliders();
      compute();
    }

    /* ------------------------------------------------------------ numbers -- */

    /** Changing the timeline changes every rate, so the whole page re-runs. */
    function computeWindow() {
      stats = CxModel.stats(R.frames, state.windowWeeks);
      state.plan = CxModel.clampPlan(state.plan, stats);
      renderWindowChips();
      renderKpis();
      syncSliders();
      compute();
    }

    function compute() {
      cost = CxModel.cost(state.plan, stats, R.assumptions);

      const ceiling = Math.max(10, stats.total.debtRate * 2, stats.total.fixRate * 2, cost.count / 13, 1);
      const paceMax = Math.ceil(ceiling / 10) * 10;
      const paceInput = $('pace');
      paceInput.max = String(paceMax);
      paceInput.step = String(Math.max(1, Math.round(paceMax / 200)));
      paceInput.value = String(Math.min(state.pace, paceMax));
      state.pace = Number(paceInput.value);

      forecast = CxModel.forecast({
        backlog: stats.total.backlog,
        debtRate: stats.total.debtRate,
        selected: cost.count,
        pace: state.pace,
        horizonWeeks: CxModel.monthsToWeeks(state.horizonMonths),
        startWeek: stats.lastWeek,
      });

      renderSummary();
      renderMatrix();
      renderForecast();
      renderHistoryCharts();
    }

    function renderSummary() {
      const reduction = cost.backlog > 0 ? cost.count / cost.backlog : 0;
      $('summary-row').innerHTML = `
        <div class="kpi accent">
          <div class="label">Forecast cost</div>
          <div class="value">${CxModel.compact(cost.total)}</div>
          <div class="note">${CxModel.int(cost.total)} credits — ${CxModel.int(cost.triage)} triage + ${CxModel.int(cost.remediation)} remediation</div>
        </div>
        <div class="kpi">
          <div class="label">Selected to triage</div>
          <div class="value">${CxModel.compact(cost.count)}</div>
          <div class="note">of ${CxModel.int(cost.backlog)} open · ${CxModel.int(cost.truePositives)} expected to be real</div>
        </div>
        <div class="kpi">
          <div class="label">Backlog reduction</div>
          <div class="value">${CxModel.pct(reduction, 1)}</div>
          <div class="note">leaves ${CxModel.int(cost.backlogAfter)} of today's backlog open</div>
        </div>
        <div class="kpi">
          <div class="label">Time to work through it</div>
          <div class="value small">${cost.count > 0 ? CxModel.weeksAsDuration(forecast.weeksToFinishPlan) : '—'}</div>
          <div class="note">${cost.count > 0
            ? `at ${CxModel.int(state.pace)} findings a week`
            : 'nothing selected yet'}</div>
        </div>`;

      const sevColors = colors();
      cost.rows.forEach((row) => {
        const foot = $('sev-grid').querySelector(`[data-cost-out="${row.severity}"]`);
        if (!foot) return;
        foot.innerHTML = row.selected === 0
          ? 'Not in this plan — no credits.'
          : `<strong>${CxModel.int(row.total)} credits</strong> · ${CxModel.int(row.truePositives)} to fix` +
            (row.deferred > 0 ? ` · ${CxModel.int(row.deferred)} left open` : '');
        foot.style.borderTopColor = sevColors[row.severity];
      });
    }

    /**
     * Metrics down the side, severities across the top. Reading down a column
     * answers "what does Critical cost"; reading across a row answers "where
     * does the money go". Both get asked out loud in the meeting.
     */
    function renderMatrix() {
      const label = windowName();
      const head = ['<th style="text-align:left">Metric</th>']
        .concat(SEV.map((s) => `<th><span class="sev-head-cell">${dot(s)}${s}</span></th>`))
        .concat(['<th class="total-col">Total</th>']).join('');

      const row = (name, cells, total, cls) =>
        `<tr class="${cls || ''}"><td>${name}</td>` +
        cells.map((c) => `<td>${c}</td>`).join('') +
        `<td class="total-col">${total}</td></tr>`;

      const rows = [
        row('Open backlog', SEV.map((s) => CxModel.int(stats.bySeverity[s].backlog)),
          CxModel.int(stats.total.backlog)),
        row(`Debt increase (${label})`,
          SEV.map((s) => CxModel.pct(stats.bySeverity[s].debtIncrease, 1)),
          CxModel.pct(stats.total.debtIncrease, 1), 'is-muted'),
        row(`Cleared (${label})`,
          SEV.map((s) => CxModel.pct(stats.bySeverity[s].clearedShare, 1)),
          CxModel.pct(stats.total.clearedShare, 1), 'is-muted'),
        row(`Kept up with arrivals (${label})`,
          SEV.map((s) => CxModel.pct(stats.bySeverity[s].keepUp)),
          CxModel.pct(stats.total.keepUp), 'is-muted'),
        row('Selected to triage', SEV.map((s) => CxModel.int(cost.bySeverity[s].selected)),
          CxModel.int(cost.count), 'is-highlight'),
        row('False positive %', SEV.map((s) => `${Math.round(cost.bySeverity[s].fp)}%`),
          cost.count > 0 ? `${Math.round((cost.falsePositives / cost.count) * 100)}%` : '—', 'is-muted'),
        row('True positives (est.)', SEV.map((s) => CxModel.int(cost.bySeverity[s].truePositives)),
          CxModel.int(cost.truePositives)),
        row(`Triage credits (${R.assumptions.triageCredits}/item)`,
          SEV.map((s) => CxModel.int(cost.bySeverity[s].triage)), CxModel.int(cost.triage)),
        row(`Remediation credits (${R.assumptions.remediationCredits}/true positive)`,
          SEV.map((s) => CxModel.int(cost.bySeverity[s].remediation)), CxModel.int(cost.remediation)),
        row('Total credits', SEV.map((s) => `<strong>${CxModel.int(cost.bySeverity[s].total)}</strong>`),
          `<strong>${CxModel.int(cost.total)}</strong>`, 'is-total'),
        row('Backlog after this plan', SEV.map((s) => CxModel.int(cost.bySeverity[s].backlogAfter)),
          CxModel.int(cost.backlogAfter)),
      ].join('');

      $('table-cost').innerHTML =
        `<table class="matrix"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }

    function renderForecast() {
      const scenario = scenarioColors();
      const labels = forecast.weeks.map((w) => CxCharts.shortDate(w.date));
      const series = [
        { key: 'nothing', color: scenario.nothing, dashed: true,
          values: forecast.weeks.map((w) => w.noAction), endLabel: CxModel.compact(forecast.endNoAction) },
        { key: 'plan', color: scenario.target,
          values: forecast.weeks.map((w) => w.withPlan), endLabel: CxModel.compact(forecast.endWithPlan) },
      ];
      const tips = forecast.weeks.map((w) =>
        `<div class="t-title">Week ${w.week} — ${CxCharts.shortDate(w.date)}</div>` +
        `<div class="t-row"><span>Do nothing</span><span>${CxModel.int(w.noAction)}</span></div>` +
        `<div class="t-row"><span>With this plan</span><span>${CxModel.int(w.withPlan)}</span></div>` +
        `<div class="t-row t-total"><span>Difference</span><span>${CxModel.int(w.noAction - w.withPlan)}</span></div>`);

      $('chart-forecast').innerHTML = CxCharts.lines({
        id: 'forecast', labels, series, tipRows: tips, height: 280,
      });
      $('legend-forecast').innerHTML =
        `<span class="item"><span class="swatch line" style="background:${scenario.nothing}"></span>Do nothing</span>` +
        `<span class="item"><span class="swatch line" style="background:${scenario.target}"></span>This plan at ${CxModel.int(state.pace)}/week</span>`;

      $('pace-out').textContent = CxModel.int(state.pace);
      $('forecast-sub').textContent =
        `Next ${state.horizonMonths} months. Both futures take the same ${CxModel.int(forecast.arrivals)} ` +
        'new findings a week — measured from your own exports, not assumed. Only the pace differs.';

      if (forecast.scope <= 0) {
        $('forecast-note').innerHTML =
          'Nothing is selected, so this plan costs nothing and moves nothing — the backlog keeps taking ' +
          `<strong>${CxModel.int(forecast.arrivals)}</strong> new findings a week. ` +
          'Move a slider above to build a plan.';
        return;
      }

      const holds = forecast.pace >= forecast.arrivals;
      $('forecast-note').innerHTML =
        `<strong>${CxModel.int(forecast.pace)} findings a week</strong> works through the ` +
        `${CxModel.int(forecast.scope)} selected above in <strong>${CxModel.weeksAsDuration(forecast.weeksToFinishPlan)}</strong>, ` +
        `for <strong>${CxModel.int(cost.total)} credits</strong>. ` +
        (holds
          ? `That also outruns the ${CxModel.int(forecast.arrivals)} findings arriving each week, so the whole backlog ` +
            `reaches zero in <strong>${CxModel.weeksAsDuration(forecast.weeksToZero)}</strong>.`
          : `It does not keep up with the ${CxModel.int(forecast.arrivals)} arriving each week, so the backlog keeps ` +
            `growing meanwhile: <strong>${CxModel.int(forecast.paceToHold)} a week</strong> holds the line, and ` +
            'anything above that starts killing the debt.');
    }

    /* ----------------------------------------------------------- the trend -- */

    function renderHistoryCharts() {
      const sevColors = colors();
      const flow = flowColors();
      const weeks = R.frames.weeks;
      const labels = weeks.map(CxCharts.shortDate);

      const series = SEV.slice().reverse().map((s) => ({
        key: s, color: sevColors[s], values: R.frames.open[s].map((v) => v || 0),
      }));
      const backlogTips = weeks.map((week, i) => {
        const rows = SEV.map((s) =>
          `<div class="t-row"><span>${s}</span><span>${CxModel.int(R.frames.open[s][i])}</span></div>`).join('');
        const total = CxModel.sum(SEV.map((s) => R.frames.open[s][i] || 0));
        return `<div class="t-title">${week}</div>${rows}` +
          `<div class="t-row t-total"><span>Open</span><span>${CxModel.int(total)}</span></div>`;
      });
      $('chart-backlog').innerHTML = CxCharts.stackedArea({
        id: 'backlog', labels, series, tipRows: backlogTips, height: 280,
      });
      $('legend-backlog').innerHTML = SEV.map((s) =>
        `<span class="item"><span class="swatch" style="background:${sevColors[s]}"></span>${s}</span>`).join('');

      const introduced = CxModel.rollup(R.frames.introduced);
      const cleared = CxModel.rollup(R.frames.fixed);
      const flowTips = weeks.map((week, i) =>
        `<div class="t-title">${week}</div>` +
        `<div class="t-row"><span>Arrived</span><span>${CxModel.int(introduced[i])}</span></div>` +
        `<div class="t-row"><span>Closed</span><span>${CxModel.int(cleared[i])}</span></div>` +
        `<div class="t-row t-total"><span>Net</span><span>${CxModel.signed(
          introduced[i] === null || cleared[i] === null ? null : introduced[i] - cleared[i])}</span></div>`);
      $('chart-flow').innerHTML = CxCharts.flow({
        id: 'flow', labels, height: 260, tipRows: flowTips,
        groups: [
          { key: 'in', color: flow.introduced, values: introduced },
          { key: 'out', color: flow.cleared, values: cleared },
        ],
      });
      $('legend-flow').innerHTML =
        `<span class="item"><span class="swatch" style="background:${flow.introduced}"></span>New findings (debt rate)</span>` +
        `<span class="item"><span class="swatch" style="background:${flow.cleared}"></span>Findings closed (fix rate)</span>`;

      $('table-history').innerHTML =
        '<table><thead><tr><th style="text-align:left">Week ending</th><th>Open</th>' +
        '<th>Arrived</th><th>Closed</th><th>Net</th></tr></thead><tbody>' +
        weeks.map((week, i) =>
          `<tr><td>${week}</td>` +
          `<td>${CxModel.int(CxModel.sum(SEV.map((s) => R.frames.open[s][i] || 0)))}</td>` +
          `<td>${CxModel.int(introduced[i])}</td><td>${CxModel.int(cleared[i])}</td>` +
          `<td>${CxModel.signed(introduced[i] === null || cleared[i] === null ? null : introduced[i] - cleared[i])}</td></tr>`
        ).join('') + '</tbody></table>';
    }

    /* ----------------------------------------------------------------- wiring -- */

    $('pace').addEventListener('input', () => { state.pace = Number($('pace').value); compute(); });
    $('fp-all').addEventListener('input', () => {
      const value = Number($('fp-all').value);
      $('fp-all-out').textContent = `${value}%`;
      setPlan((s, row) => { row.fp = value; });
    });
    $('btn-all').addEventListener('click', () => setPlan((s, row, backlog) => { row.selected = backlog; }));
    $('btn-none').addEventListener('click', () => setPlan((s, row) => { row.selected = 0; }));
    $('btn-ch').addEventListener('click', () => setPlan((s, row, backlog) => {
      row.selected = (s === 'Critical' || s === 'High') ? backlog : 0;
    }));
    $('btn-reset').addEventListener('click', () => {
      state.plan = JSON.parse(JSON.stringify(R.plan));
      state.pace = R.pace;
      state.windowWeeks = R.windowWeeks;
      state.horizonMonths = R.horizonMonths;
      $('pace').value = String(R.pace);
      renderHorizonChips();
      computeWindow();
    });
    $('btn-print').addEventListener('click', () => window.print());
    // The weekly table is collapsed on screen; a printed copy should carry it.
    window.addEventListener('beforeprint', () => {
      document.querySelectorAll('details').forEach((d) => { d.open = true; });
    });
    $('btn-theme').addEventListener('click', () => {
      document.documentElement.setAttribute('data-theme', theme() === 'dark' ? 'light' : 'dark');
      renderSliders();
      computeWindow();
    });

    renderHorizonChips();
    stats = CxModel.stats(R.frames, state.windowWeeks);
    renderSliders();
    computeWindow();
    CxCharts.bind(document);
  },

  /* ---------------------------------------------------------------- build -- */

  build(context) {
    const esc = CxCharts.esc;
    const customer = context.customer || 'Your organisation';
    const generatedLabel = new Date(context.generatedAt).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    const logo = context.logoDataUrl
      ? `<img src="${esc(context.logoDataUrl)}" alt="${esc(customer)}">`
      : CxBrand.logoSvg(34);

    const body = `
<div class="page">

  <header class="masthead">
    <span class="logo">${logo}</span>
    <div>
      <div class="customer">${esc(customer)}</div>
      <h1>${esc(context.title)}</h1>
      <p class="hint" style="margin:0">
        ${context.frames.weeks.length} weekly snapshots ·
        ${esc(context.frames.weeks[0])} to ${esc(context.frames.weeks[context.frames.weeks.length - 1])}
      </p>
    </div>
    <div class="meta">
      ${generatedLabel}<br>
      ${context.preparedBy ? `Prepared by ${esc(context.preparedBy)}<br>` : ''}
      ${context.validity ? `Valid until ${esc(context.validity)}<br>` : ''}
      <span class="no-print" style="display:inline-flex;gap:6px;margin-top:8px">
        <button type="button" class="plain" id="btn-theme">◐</button>
        <button type="button" class="plain accent" id="btn-print">Print / save PDF</button>
      </span>
    </div>
  </header>

  <div class="section-head">
    <p class="section-title">Where the backlog stands</p>
    <div class="chip-row" id="window-chips" role="group" aria-label="Timeline for the rates below"></div>
  </div>
  <p class="chip-caption" id="window-caption"></p>

  <div class="grid four" id="kpis"></div>
  <div class="card" style="margin-top:14px"><p class="headline" id="headline"></p></div>

  <p class="section-title">Choose what to fix</p>
  <section class="card">
    <header>
      <h2>Adjust the plan</h2>
      <span class="sub">Move the sliders. Every figure below follows.</span>
      <span class="locked" style="margin-left:auto">🔒 credit rates are fixed</span>
    </header>
    <div class="sev-grid" id="sev-grid"></div>
    <div class="plan-tools no-print">
      <label class="field">
        <span>Set the false-positive rate for every severity at once: <output id="fp-all-out">—</output></span>
        <input type="range" id="fp-all" min="0" max="100" step="1" value="30">
      </label>
      <div class="plan-buttons">
        <button type="button" class="plain" id="btn-all">Select all</button>
        <button type="button" class="plain" id="btn-none">Select none</button>
        <button type="button" class="plain" id="btn-ch">Critical + High</button>
        <button type="button" class="plain" id="btn-reset">Reset</button>
      </div>
    </div>
  </section>

  <p class="section-title">What it costs in Checkmarx credits</p>
  <div class="grid four" id="summary-row"></div>

  <section class="card" style="margin-top:14px">
    <header>
      <h2>Estimate</h2>
      <span class="sub">Every number that matters, by severity, in one place.</span>
    </header>
    <div class="table-scroll" id="table-cost"></div>
    <p class="hint" style="margin-top:12px">
      Every selected finding costs ${context.assumptions.triageCredits} credit to triage.
      Only the ones that turn out to be real cost a further
      ${context.assumptions.remediationCredits} to remediate — a false positive stops
      after triage. Those two rates are fixed; the scope and the false-positive
      estimates above are yours to move. “Backlog after this plan” is today’s
      backlog minus what the plan clears, not a backlog at a future date — new
      findings keep arriving, which is what the forecast below shows.
    </p>
  </section>

  <div class="section-head">
    <p class="section-title">How fast the debt dies</p>
    <div class="chip-row" id="horizon-chips" role="group" aria-label="Forecast horizon"></div>
  </div>
  <section class="card">
    <header>
      <h2>Backlog forecast</h2>
      <span class="sub" id="forecast-sub"></span>
    </header>
    <label class="field no-print" style="max-width:420px;margin-bottom:10px">
      <span>Work through <output id="pace-out">0</output> findings per week</span>
      <input type="range" id="pace" min="0" max="100" step="1" value="${context.pace}">
    </label>
    <div class="chart-wrap" id="chart-forecast"></div>
    <div class="legend" id="legend-forecast"></div>
    <div class="callout" id="forecast-note" style="margin-top:14px"></div>
  </section>

  <p class="section-title">The trend behind the numbers</p>
  <section class="card">
    <header>
      <h2>Open findings over time</h2>
      <span class="sub">Measured from the weekly exports — no projection in this chart.</span>
    </header>
    <div class="chart-wrap" id="chart-backlog"></div>
    <div class="legend" id="legend-backlog"></div>
  </section>

  <section class="card">
    <header>
      <h2>Debt rate against fix rate</h2>
      <span class="sub">Findings arriving each week against findings closed each week, in counts.</span>
    </header>
    <div class="chart-wrap" id="chart-flow"></div>
    <div class="legend" id="legend-flow"></div>
    <details>
      <summary>Show the weekly figures</summary>
      <div class="table-scroll" style="margin-top:12px" id="table-history"></div>
    </details>
  </section>

  <p class="footnote">
    From ${esc((context.provenance.totals && context.provenance.totals.fileName) || 'the open-backlog export')}
    and ${esc((context.provenance.fixed && context.provenance.fixed.fileName) || 'the fixed-findings export')},
    ${context.frames.weeks.length} weekly snapshots to ${esc(context.frames.weeks[context.frames.weeks.length - 1])}.
    New findings are derived as open(t) − open(t−1) + closed(t), so the arrival rate is
    measured rather than assumed. Generated on ${generatedLabel}; this file carries its own
    data and runs entirely in your browser — nothing is sent anywhere when you move a slider.
  </p>

</div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(customer)} — ${esc(context.title)}</title>
<style>${CxReport.css()}</style>
</head>
<body>
${body}
<script>
${CxReport.serialise('CxModel', CxModel)}
${CxReport.serialise('CxCharts', CxCharts)}
window.REPORT = ${CxReport.json(context)};
(${CxReport.runtime.toString()})();
</` + `script>
</body>
</html>`;
  },
};
