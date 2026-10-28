// Cx Credits Calculator: the projection as a PDF to present, made in the browser from the data a
// generated report keeps. Page 1: triage & remediation, the backlog and the findings still to
// come. Page 2: Checkmarx Fusion. Page 3: the credits needed overall. Page 4: the impact. Only when
// the calculations are asked for: the trend and how each number is calculated, then an appendix with
// every calculation, step by step (src: explain.js).
//
// Each page is drawn on a canvas (so every language's script and direction is drawn by the
// browser), kept as a JPEG, and the three are written into a PDF here: no library, nothing sent.

import { FREQUENCIES, HOURS_A_YEAR, SEVERITIES, aheadMonths, creditSummary, fusionTotal } from './model.js';
import { allSections, moneyText } from './explain.js';
import { forecastChart } from './charts.js';
import { assumptionItems, falsePositiveLine, reportFileName, scopeLines, trFigures, wording } from './report.js';
import { NEXTGEN_ACCENTS, lookPalette, reportLook } from '../look.js';

/** The page size in PDF points (16:9, as a presentation) and the drawing size in pixels. */
export const PAGE = { width: 960, height: 540 };
const W = 1920;
const H = 1080;

const CLASSIC = { head: '#14171c', ink: '#14171c', muted: '#5c636e', line: '#e2e5e9', soft: '#f4f6fb', key: '#eef2fc', accent: '#2856c9', fusion: '#0d9488', white: '#ffffff' };
const CLASSIC_FONT = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif';
// The colours and face of the PDF being made: the classic look's, or the next-gen look's (see useLook).
let C = CLASSIC;
let FONT = CLASSIC_FONT;

/** `a` mixed into white by `share` (0–1), as a hex colour a canvas takes. */
const tint = (a, share) => `#${[1, 3, 5].map((i) => Math.round(255 - (255 - parseInt(a.slice(i, i + 2), 16)) * share).toString(16).padStart(2, '0')).join('')}`;

/** The PDF in the app's look: next-gen has its deep header, the accent's ink and gradient, and Plus Jakarta Sans; each new look its own band and colours. */
function useLook(look) {
  const { ui, accent } = reportLook(look);
  if (ui !== 'nextgen') {
    C = CLASSIC;
    FONT = CLASSIC_FONT;
    return;
  }
  FONT = `"MZ Jakarta", "Plus Jakarta Sans", ${CLASSIC_FONT}`;
  // The reader's own look (Cabin, Residence…): its band at the top, ink, lines and colour, on a white page.
  const p = lookPalette(reportLook(look).look, accent);
  if (p) {
    const c = p.light;
    C = { ...CLASSIC, head: p.head, ink: c.ink, muted: c.muted, line: c.line, soft: tint(c.accent, 0.05), key: tint(c.accent, 0.1), accent: c.accent, from: c.accent, to: c.button };
    return;
  }
  const [ink, , from, to] = NEXTGEN_ACCENTS[accent];
  C = { ...CLASSIC, head: '#0b1020', ink: '#0b1020', muted: '#5a6478', line: '#e2e6f0', soft: '#f3f5fb', key: tint(from, 0.1), accent: ink, from, to };
}

/** HTML wording as plain text, for drawing. */
const plain = (html) => String(html ?? '').replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

export function slidesFileName(customer, at) {
  return reportFileName(customer, at).replace(/\.html$/, '_summary.pdf');
}

/**
 * What each page says, in the reader's language: titles, figures and lines, with no drawing.
 * `data` is what generating the report saved (see page.js reportData()). `calculations`: the appendix
 * of calculations too (left out unless asked for).
 */
export function slideContent(data, { t, lang = 'en', calculations = false } = {}) {
  const L = wording({ t, lang });
  const { num } = L;
  const w = (...args) => plain(L.w(...args));
  const sum = creditSummary(data.tr?.totals?.credits ?? null, fusionTotal(data.fusion, data.fusionNew), data.summary?.settings);
  const customer = data.customer || L.t('Customer');
  const months = data.tr?.months ?? data.months ?? data.fusion?.periodMonths ?? 12;
  const pages = [];

  // 1. Triage & remediation: the backlog and what is still to come.
  const tr = data.tr;
  if (tr) {
    const f = trFigures(tr);
    const a = tr.analysis?.total ?? {};
    const lines = [];
    if (Number.isFinite(a.addedPct) && Number.isFinite(a.fixedPct)) lines.push(w('Each month, new findings add {0}% to the backlog and fixes take away {1}%.', num(a.addedPct, 1), num(a.fixedPct, 1)));
    else if (Number.isFinite(tr.monthlyChange)) lines.push(tr.monthlyChange >= 0 ? w('The backlog grew by {0} a month on average recently.', num(tr.monthlyChange)) : w('The backlog shrank by {0} a month on average recently.', num(-tr.monthlyChange)));
    if (tr.ahead?.includeFuture !== false && tr.ahead?.aiDeclinePercent) lines.push(w('New findings arrive at the pace of the last {0} months, falling by {1}% over a year as teams adopt AI.', num(tr.lookbackMonths), num(tr.ahead.aiDeclinePercent)));
    pages.push({
      kind: 'tr',
      title: w('Triage & remediation'),
      subtitle: tr.ahead?.includeFuture === false ? w('The backlog today, triaged and remediated over the next {0} months', num(months)) : w('The backlog today and the findings still to come over the next {0} months', num(months)),
      figures: [
        // Every open vulnerability today, small: what the plan takes from it comes next.
        { label: w('Total open vulnerabilities today'), value: num(f.backlog), small: true },
        // Still to come only when it is counted.
        ...(tr.ahead?.includeFuture === false ? [] : [{ label: tr.ahead?.aiDeclinePercent ? w('Still to come, {0}% fewer over a year with AI', num(tr.ahead.aiDeclinePercent)) : w('Still to come, at the current pace'), value: `+${num(f.future)}` }]),
        { label: w('To triage'), value: num(f.toTriage), notes: [w('{0} to remediate', num(f.truePositives)), ...scopeLines(tr, L).map(plain)] },
        { label: w('Triage & remediation credits'), value: num(f.credits), key: true, notes: [plain(falsePositiveLine(tr, L))].filter(Boolean) },
      ],
      chart: tr.forecast?.length ? { kind: 'forecast', points: tr.forecast, title: w('Backlog trend and forecast'), legend: [[w('Backlog'), C.ink, false], [w('If nothing changes'), '#dc2626', true], [w('With this plan'), C.accent, true]] } : null,
      lines,
    });
  } else pages.push({ kind: 'tr', title: w('Triage & remediation'), subtitle: '', figures: [], chart: null, lines: [w('Triage & remediation is not in this projection.')] });

  // 2. Checkmarx Fusion: the projects, their scans and the credits, by how often they are scanned.
  const fu = data.fusion;
  const fn = data.fusionNew;
  // The new customer's code (cloc): one line on the Fusion page, its own part of the total.
  const newLine = fn ? [w('New customer (code counted with cloc): {0} projects, {1} lines, {2} Fusion scans, {3} credits.', num(fn.totals?.projects), num(fn.totals?.lines), num(fn.totals?.scans), num(fn.totals?.credits))] : [];
  if (fu) {
    const T = fu.totals ?? {};
    const label = (id) => w(FREQUENCIES.find((x) => x.id === id)?.label ?? '—');
    const bars = (fu.byFrequency ?? []).filter((b) => b.projects && b.credits > 0).map((b) => ({ label: label(b.id), value: b.credits, text: num(b.credits), note: w('{0} projects', num(b.projects)) }));
    const models = (fu.byModel ?? []).filter((m) => m.credits > 0).map((m) => `${m.name || '—'} · ${w('Credits per 10K LOC')} ${num(m.rate, 2)} · ${w('Credits')} ${num(m.credits)}`);
    pages.push({
      kind: 'fusion',
      title: w('Checkmarx Fusion'),
      subtitle: w('Fusion scans over {0} months', num(fu.periodMonths)),
      figures: [
        { label: w('Projects'), value: num(T.projects) },
        { label: w('Lines of code'), value: num(T.lines) },
        { label: w('Fusion scans over {0} months', num(fu.periodMonths)), value: num(T.scans) },
        { label: w('Fusion credits'), value: num(T.credits), key: true },
      ],
      bars: bars.length ? { title: w('Fusion credits by how often projects are scanned'), items: bars } : null,
      lines: [...(models.length ? [`${w('Models')}: ${models.join('; ')}`] : []), ...newLine],
    });
  } else if (fn) {
    const T = fn.totals ?? {};
    pages.push({
      kind: 'fusion',
      title: w('Checkmarx Fusion'),
      subtitle: w('Fusion — new customer: code counted with cloc'),
      figures: [
        { label: w('Projects'), value: num(T.projects) },
        { label: w('Lines of code'), value: num(T.lines) },
        { label: w('Fusion scans over {0} months', num(fn.periodMonths)), value: num(T.scans) },
        { label: w('Fusion credits'), value: num(T.credits), key: true },
      ],
      bars: null,
      lines: [],
    });
  } else pages.push({ kind: 'fusion', title: w('Checkmarx Fusion'), subtitle: '', figures: [], lines: [w('Fusion is not in this projection.')] });

  // 3. Overall: the credits needed, what they are for, and the assumptions.
  const f = tr ? trFigures(tr) : null;
  const parts = [
    f && { label: w('Backlog today'), value: f.backlogCredits, colour: C.ink },
    f && f.aheadCredits > 0 && { label: w('Findings ahead'), value: f.aheadCredits, colour: C.accent },
    fu && { label: fn ? w('Fusion — existing customer') : w('Fusion scans'), value: fu.totals?.credits ?? 0, colour: C.fusion },
    fn && { label: w('Fusion — new customer'), value: fn.totals?.credits ?? 0, colour: '#b7791f' },
    sum.extra > 0 && { label: w('Extra credits'), value: sum.extra, colour: '#9aa1ab' },
  ].filter((p) => p && p.value > 0).map((p) => ({ ...p, text: num(p.value) }));
  pages.push({
    kind: 'total',
    title: w('Total credits required'),
    subtitle: [w('{0} bundles of {1} credits', num(sum.bundles), num(sum.settings.bundleCredits)), months ? w('over {0} months', num(months)) : '', sum.settings.extraPercent ? w('including {0}% extra', num(sum.settings.extraPercent, 2)) : ''].filter(Boolean).join(' · '),
    total: num(sum.total),
    parts,
    lines: assumptionItems(data, sum, L).map(plain),
  });

  // 4. Impact: what all the credits give back (triage & remediation and Fusion), against what they cost.
  const im = data.impact;
  if (im && (im.tr || im.fusion)) {
    const o = im.overall ?? {};
    const tri = im.tr;
    const fu = im.fusion;
    const cur = (tri ?? fu).settings.currency;
    const cash = (n) => plain(moneyText(n, cur, L.locale));
    const SOURCE = { triage: w('AI Triage'), fixes: w('AI Remediation'), expert: w('Expert review replaced'), early: w('Found earlier, fixed cheaper'), breach: w('Breach cost avoided') };
    const byMoney = o.value !== null && o.value !== undefined;
    const bars = (o.sources ?? [])
      .map((x) => ({ label: SOURCE[x.key], value: byMoney ? x.value ?? 0 : x.hours, text: byMoney ? cash(x.value ?? 0) : num(x.hours), note: x.hours ? w('{0} hours', num(x.hours)) : w('An expected cost'), colour: x.key === 'breach' ? C.muted : x.key === 'expert' || x.key === 'early' ? C.fusion : C.accent }))
      .filter((b) => b.value > 0);
    const lines = [];
    if (tri) lines.push(w('{0} false positives cleared: none of them reaches a developer.', num(tri.cleared)));
    if (fu) lines.push(w('Fusion reads every line {0} times; a team of {1} would take {2} weeks to read it once.', num(fu.timesRead, 1), num(fu.settings.reviewers), num(fu.teamWeeks, 1)));
    if (fu?.breachAvoided && !fu.settings.countBreach) lines.push(w('Breach cost avoided, an expected cost not counted in the return: {0}.', cash(fu.breachAvoided)));
    if (o.paybackMonths !== null && o.paybackMonths !== undefined) lines.push(w('The credits are paid back in {0} months.', num(o.paybackMonths, 1)));
    pages.push({
      kind: 'impact',
      title: w('What the credits give back'),
      subtitle: tri && fu ? w('Triage & remediation and Fusion over {0} months', num(o.months)) : tri ? w('Triage & remediation over {0} months', num(tri.months)) : w('Fusion over {0} months', num(fu.months)),
      figures: [
        { label: w('All the credits give back'), value: byMoney ? cash(o.value) : `${num(o.hours)} ${w('hours')}`, key: true },
        { label: w('What the credits cost'), value: o.cost === null || o.cost === undefined ? '—' : cash(o.cost) },
        { label: w('Return'), value: o.roi === null || o.roi === undefined ? '—' : `${num(o.roi * 100)}%` },
        { label: w('Hours given back'), value: num(o.hours), note: w('{0} developer-years', num(o.hours / HOURS_A_YEAR, 1)) },
      ],
      bars: bars.length ? { title: byMoney ? w('Where the value comes from') : w('Where the hours come from'), items: bars } : null,
      lines,
    });
  }

  const made = new Date(data.generatedAt ?? Date.now()).toLocaleDateString(L.locale, { day: 'numeric', month: 'long', year: 'numeric' });
  const content = {
    customer,
    eyebrow: data.organisation ? plain(data.organisation) : w('Checkmarx credits projection'),
    footer: data.preparedBy ? w('Made {0} by {1}', made, data.preparedBy) : w('Made {0}', made),
    pages,
    appendix: [],
    appendixTitle: w('Appendix: how each number is calculated'),
    of: (i, total = pages.length) => `${i + 1} / ${total}`,
    heading: (page) => `${customer}: ${page.title}`,
  };
  if (!calculations) return content;

  // 5. The appendix begins: what it holds, and on which pages (filled in once the pages are laid out).
  pages.push({
    kind: 'section',
    title: w('Appendix – Calculations'),
    subtitle: w('How every number in this summary is worked out, for anyone who wants to check it.'),
    label: w('Calculations'),
    contents: [
      { kind: 'trend', text: w('The trend and how each number is calculated'), pages: '' },
      { kind: 'appendix', text: w('Every number, step by step'), pages: '' },
    ],
  });

  // 6. The trend, and every number's calculation in one line.
  const calc = [];
  if (tr) {
    const T = tr.totals ?? {};
    const A = tr.ahead ?? {};
    const paced = tr.paced ?? aheadMonths(tr.months ?? months, A.aiDeclinePercent ?? 0);
    const monthly = T.arrivals ?? (paced ? (T.future ?? 0) / paced : 0);
    const chosen = SEVERITIES.filter((x) => (tr.rows?.[x]?.selected ?? 0) > 0);
    calc.push({ label: w('Backlog today'), formula: `${chosen.map((x) => num(tr.rows[x].selected)).join(' + ') || '0'} = ${num(T.selected)} (${w('of {0} open', num(T.backlog))})` });
    if (A.includeFuture !== false) calc.push({ label: w('Still to come'), formula: `${num(monthly)} × ${num(paced, 2)} = ${num(T.future)}` });
    calc.push({ label: w('More found by Fusion'), formula: !tr.fusion ? '0' : tr.sastOnly ? w('{0}% × {1} SAST findings = {2}', num(A.fusionUpliftPercent), num(T.fusionBase), num(T.fusionExtra)) : `${num(A.fusionUpliftPercent)}% × (${num(T.selected)} + ${num(T.future)}) = ${num(T.fusionExtra)}` });
    calc.push({ label: w('To triage'), formula: `${[T.selected, ...(A.includeFuture !== false ? [T.future] : []), ...(tr.fusion ? [T.fusionExtra] : [])].map((n) => num(n)).join(' + ')} = ${num(T.toTriage)}` });
    const fps = [...new Set(SEVERITIES.filter((x) => (tr.rows?.[x]?.selected ?? 0) + (tr.rows?.[x]?.future ?? 0) > 0).map((x) => tr.rows[x].fp))];
    const reported = T.selected + T.future + T.fusionExtra;
    calc.push({ label: w('To remediate (true positives)'), formula: fps.length === 1 ? `${num(reported)} × ${num(100 - fps[0])}% = ${num(T.truePositives)}` : `${SEVERITIES.filter((x) => tr.rows?.[x]?.truePositives > 0).map((x) => num(tr.rows[x].truePositives)).join(' + ')} = ${num(T.truePositives)}` });
    calc.push({ label: w('Triage & remediation credits'), formula: `${num(T.triageCredits)} + ${num(T.remediationCredits)} = ${num(T.credits)}` });
  }
  if (fu) calc.push({ label: fn ? w('Fusion — existing customer') : w('Fusion credits'), formula: `Σ ${w('10K units × scans')} × ${w('Credits per 10K LOC')} = ${num(fu.totals?.credits)}` });
  if (fn) calc.push({ label: w('Fusion — new customer'), formula: `Σ ${w('10K units × scans')} × ${w('Credits per 10K LOC')} = ${num(fn.totals?.credits)}` });
  calc.push({ label: w('Total credits required'), formula: `${sum.tr !== null && sum.fusion !== null ? `${num(sum.tr)} + ${num(sum.fusion)} = ` : ''}${num(sum.base)}${sum.extra ? ` + ${num(sum.settings.extraPercent, 2)}% = ${num(sum.total)}` : ''}; ${num(sum.total)} ÷ ${num(sum.settings.bundleCredits)} = ${num(sum.exactBundles, 2)} → ${num(sum.bundles)}` });
  const an = (x) => tr?.analysis?.[x] ?? {};
  pages.push({
    kind: 'trend',
    title: w('The trend and how each number is calculated'),
    subtitle: tr ? w('The trend is measured over the last {0} months; the projection covers the next {1} months.', num(tr.lookbackMonths), num(tr.months ?? months)) : '',
    trend: tr
      ? {
          sentence: Number.isFinite(an('total').addedPct) ? w('Each month, new findings add {0}% to the backlog and fixes take away {1}%.', num(an('total').addedPct, 1), num(an('total').fixedPct, 1)) : '',
          head: [w('Severity'), w('Open now'), w('Added a month'), w('Fixed a month'), w('Change a month')],
          rows: [...SEVERITIES.map((x) => [w(x), an(x)]), [w('Total'), an('total')]].map(([label, a]) => [label, num(a.current), num(a.arrivals), num(a.fixedMonthly), Number.isFinite(a.netMonthly) ? `${a.netMonthly > 0.5 ? '+' : a.netMonthly < -0.5 ? '−' : ''}${num(Math.abs(a.netMonthly))}` : '—']),
        }
      : null,
    calcTitle: w('How each number is calculated'),
    calc,
  });

  // The appendix: every calculation, step by step, as the report's "How each number is calculated".
  content.appendix = allSections(data, L).filter((x) => x.key !== 'future' || data.tr?.ahead?.includeFuture !== false).map((x) => ({ title: plain(x.title), lines: x.lines.map((l) => ({ text: plain(l.text), sub: Boolean(l.sub), total: Boolean(l.total) })) }));
  return content;
}

// ---------------------------------------------------------------------------------------------
// Drawing (browser only)
// ---------------------------------------------------------------------------------------------

/** A chart's SVG as an image the canvas can draw. */
async function svgImage(html, width, height) {
  const svg = html.match(/<svg[\s\S]*<\/svg>/)?.[0];
  if (!svg) return null;
  const sized = svg.replace(/^<svg /, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `).replace(/style="width:100%;max-width:\d+px;height:auto;display:block;direction:ltr;overflow:hidden"/, `style="direction:ltr;font-family:${FONT.replace(/"/g, "'")}"`);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  await img.decode();
  return img;
}

/** `text` in lines no wider than `max` (by words, or by characters where a script has no spaces). */
function wrap(ctx, text, max) {
  const out = [];
  let line = '';
  const push = (piece) => {
    const next = line + piece;
    if (ctx.measureText(next.trim()).width <= max || !line.trim()) line = next;
    else {
      out.push(line.trim());
      line = piece.trimStart();
    }
  };
  for (const word of String(text).split(/(\s+)/)) {
    if (ctx.measureText(word).width > max) for (const ch of word) push(ch);
    else push(word);
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

function drawPage(ctx, content, page, index, { rtl, images, total }) {
  const X = (x, width = 0) => (rtl ? W - x - width : x);
  const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;
  const text = (s, x, y, { size = 28, weight = 400, colour = C.ink, align = 'start' } = {}) => {
    ctx.font = font(size, weight);
    ctx.fillStyle = colour;
    ctx.textAlign = align;
    ctx.fillText(s, X(x), y);
  };
  const lines = (s, x, y, max, opts = {}) => {
    ctx.font = font(opts.size ?? 28, opts.weight ?? 400);
    const rows = wrap(ctx, s, max);
    rows.forEach((row, i) => text(row, x, y + i * (opts.lead ?? 40), opts));
    return y + rows.length * (opts.lead ?? 40);
  };
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.fillStyle = C.white;
  ctx.fillRect(0, 0, W, H);
  // The band at the top: who it is for, and what this page is.
  ctx.fillStyle = C.head;
  ctx.fillRect(0, 0, W, 170);
  if (C.from) {
    // Next-gen: the accent's gradient under the band.
    const line = ctx.createLinearGradient(0, 0, W, 0);
    line.addColorStop(rtl ? 1 : 0, C.from);
    line.addColorStop(rtl ? 0 : 1, C.to);
    ctx.fillStyle = line;
    ctx.fillRect(0, 170, W, 6);
  }
  text(content.eyebrow, 80, 66, { size: 26, colour: '#c3c8cf' });
  ctx.font = font(48, 600);
  text(wrap(ctx, content.heading(page), W - 360)[0] ?? '', 80, 128, { size: 48, weight: 600, colour: C.white });
  text(content.of(index, total), W - 80, 66, { size: 26, colour: '#c3c8cf', align: 'end' });
  if (page.subtitle) lines(page.subtitle, 80, 232, W - 160, { size: 30, colour: C.muted });
  text(content.footer, 80, H - 40, { size: 22, colour: C.muted });

  if (page.kind === 'trend') {
    // Left: the trend by severity. Right: one line per number, with its calculation.
    let y = 300;
    if (page.trend) {
      if (page.trend.sentence) y = lines(page.trend.sentence, 80, y, 820, { size: 28, lead: 38 }) + 24;
      const cols = [80, 330, 490, 650, 810];
      page.trend.head.forEach((h, i) => lines(h, cols[i] + (i ? 140 : 0), y, i ? 140 : 230, { size: 20, colour: C.muted, lead: 24, align: i ? 'end' : 'start' }));
      y += 56;
      page.trend.rows.forEach((row, r) => {
        if (r === page.trend.rows.length - 1) {
          ctx.fillStyle = C.line;
          ctx.fillRect(X(80, 870), y - 34, 870, 2);
        }
        row.forEach((cell, i) => text(cell, cols[i] + (i ? 140 : 0), y, { size: 24, weight: r === page.trend.rows.length - 1 ? 600 : 400, align: i ? 'end' : 'start' }));
        y += 44;
      });
    }
    let cy = 300;
    text(page.calcTitle, 1000, cy, { size: 28, weight: 600 });
    cy += 48;
    for (const item of page.calc) {
      if (cy > H - 100) break;
      cy = lines(item.label, 1000, cy, 840, { size: 21, colour: C.muted, lead: 26 });
      cy = lines(item.formula, 1000, cy + 4, 840, { size: 25, weight: 500, lead: 32 }) + 14;
    }
    return;
  }

  if (page.kind === 'appendix') {
    for (const row of page.rows) text(row.text, row.x, row.y, row.style);
    return;
  }

  if (page.kind === 'section') {
    // The appendix's opening: a large word, then what follows and on which pages.
    text(page.label, 80, 410, { size: 96, weight: 600, colour: C.accent });
    ctx.fillStyle = C.line;
    ctx.fillRect(X(80, W - 160), 470, W - 160, 2);
    let y = 560;
    for (const item of page.contents) {
      text(item.pages, 80, y, { size: 34, weight: 600, colour: C.accent });
      y = lines(item.text, 260, y, W - 340, { size: 34, lead: 46 }) + 30;
    }
    return;
  }

  if (page.kind === 'total') {
    text(page.total, 80, 400, { size: 140, weight: 600, colour: C.accent });
    const sum = page.parts.reduce((a, p) => a + p.value, 0) || 1;
    let x = 80;
    const barW = W - 160;
    for (const p of page.parts) {
      const width = Math.max(6, (p.value / sum) * barW - 4);
      ctx.fillStyle = p.colour;
      ctx.fillRect(X(x, width), 450, width, 36);
      x += width + 4;
    }
    let ky = 540;
    page.parts.forEach((p, i) => {
      const kx = 80 + (i % 2) * 880;
      if (i && i % 2 === 0) ky += 52;
      ctx.fillStyle = p.colour;
      ctx.fillRect(X(kx, 22), ky - 20, 22, 22);
      text(p.label, kx + 36, ky, { size: 28, colour: C.muted });
      text(p.text, kx + 800, ky, { size: 30, weight: 600, align: 'end' });
    });
    let y = ky + 90;
    for (const line of page.lines) {
      if (y > H - 100) break;
      text('•', 80, y, { size: 24, colour: C.muted });
      y = lines(line, 110, y, W - 200, { size: 24, colour: C.ink, lead: 34 }) + 8;
    }
    return;
  }

  // The figures down the side, the picture beside them, the lines under it.
  let fy = 290;
  // Small print under a figure (to remediate, what is included and excluded, the false positives): as many lines
  // as it needs. When the column would run into the footer, the figures close up a little.
  ctx.font = font(20);
  const notesOf = page.figures.map((fig) => (fig.notes ?? []).flatMap((n) => wrap(ctx, n, 504)));
  const sizes = (compact) => page.figures.map((fig, i) => (fig.small ? 108 : compact ? 134 : 150) + notesOf[i].length * (compact ? 24 : 26) + (notesOf[i].length ? 8 : 0));
  const compact = sizes(false).reduce((a, h) => a + h + 14, fy) > H - 80;
  const heights = sizes(compact);
  page.figures.forEach((fig, i) => {
    const small = notesOf[i];
    const base = fig.small ? 108 : compact ? 134 : 150;
    ctx.fillStyle = fig.key ? C.key : C.soft;
    ctx.fillRect(X(80, 560), fy, 560, heights[i]);
    const after = lines(fig.label, 108, fy + 44, 504, { size: 24, colour: C.muted, lead: 30 });
    const valueY = fig.small ? Math.max(after + 26, fy + 86) : Math.max(after + (compact ? 30 : 36), fy + (compact ? 100 : 112));
    text(fig.value, 108, valueY, { size: fig.small ? 36 : compact ? 48 : 54, weight: 600, colour: fig.key ? C.accent : C.ink });
    if (fig.note) text(fig.note, 612, valueY, { size: 22, colour: C.muted, align: 'end' });
    small.forEach((row, j) => text(row, 108, fy + base + j * (compact ? 24 : 26), { size: 20, colour: C.muted }));
    fy += heights[i] + (compact ? 10 : 14);
  });
  const left = page.figures.length ? 700 : 80;
  const width = W - left - 80;
  let y = 300;
  if (page.chart && images.chart) {
    text(page.chart.title, left, y, { size: 28, weight: 600 });
    const h = Math.round((width / images.chart.width) * images.chart.height);
    ctx.drawImage(images.chart, X(left, width), y + 20, width, h);
    y += 20 + h + 40;
    let lx = left;
    for (const [label, colour, dashed] of page.chart.legend) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 4;
      ctx.setLineDash(dashed ? [10, 7] : []);
      ctx.beginPath();
      ctx.moveTo(X(lx), y - 9);
      ctx.lineTo(X(lx + 36), y - 9);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = font(24);
      text(label, lx + 48, y, { size: 24, colour: C.muted });
      lx += 48 + ctx.measureText(label).width + 40;
    }
    y += 40;
  } else if (page.bars) {
    text(page.bars.title, left, y, { size: 28, weight: 600 });
    y += 40;
    const max = Math.max(...page.bars.items.map((b) => b.value)) || 1;
    const labelW = 330;
    const barMax = width - labelW - 180;
    for (const b of page.bars.items.slice(0, 7)) {
      lines(b.label, left, y + 30, labelW - 20, { size: 24, colour: C.ink, lead: 28 });
      const bw = Math.max(6, (b.value / max) * barMax);
      ctx.fillStyle = b.colour ?? C.fusion;
      ctx.fillRect(X(left + labelW, bw), y + 6, bw, 34);
      text(b.text, left + labelW + bw + 14, y + 33, { size: 26, weight: 600 });
      text(b.note, left + labelW, y + 70, { size: 20, colour: C.muted });
      y += 92;
    }
    y += 10;
  }
  for (const line of page.lines) {
    if (y > H - 110) break;
    y = lines(line, left, y + 10, width, { size: 28, colour: C.ink, lead: 40 }) + 12;
  }
}

/** The appendix flowed into two columns a page, as many pages as it takes. */
function layoutAppendix(ctx, content) {
  const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;
  const colW = 850;
  const top = 240;
  const bottom = H - 90;
  const rows = [];
  for (const section of content.appendix) {
    rows.push({ gap: 14, lead: 38, style: { size: 26, weight: 600, colour: C.ink }, indent: 0, text: section.title, keep: true });
    for (const l of section.lines) {
      const style = { size: 21, weight: l.total ? 600 : 400, colour: l.sub ? C.muted : C.ink };
      ctx.font = font(style.size, style.weight);
      for (const piece of wrap(ctx, l.text, colW - (l.sub ? 28 : 0))) rows.push({ gap: 0, lead: 29, style, indent: l.sub ? 28 : 0, text: piece });
    }
  }
  const pages = [];
  let page = null;
  let col = 2;
  let y = bottom;
  for (const [i, r] of rows.entries()) {
    // A section title never ends a column on its own.
    const need = r.gap + r.lead + (r.keep && rows[i + 1] ? rows[i + 1].lead : 0);
    if (y + need > bottom) {
      col += 1;
      if (col > 1) {
        page = { kind: 'appendix', title: content.appendixTitle, subtitle: '', rows: [] };
        pages.push(page);
        col = 0;
      }
      y = top;
    }
    y += r.gap;
    page.rows.push({ text: r.text, x: 80 + col * (colW + 60) + r.indent, y: y + r.lead - 8, style: r.style });
    y += r.lead;
  }
  return pages;
}

/** The appendix's opening page says on which pages its parts are: "5", "6–7". */
export function numberContents(all) {
  const section = all.find((p) => p.kind === 'section');
  if (!section) return;
  for (const item of section.contents) {
    const at = all.flatMap((p, i) => (p.kind === item.kind ? [i + 1] : []));
    item.pages = at.length > 1 ? `${at[0]}–${at.at(-1)}` : String(at[0] ?? '');
  }
}

/** The pages as JPEGs, drawn in the reader's language and direction. */
export async function drawSlides(data, { t, lang = 'en', dir = 'ltr', look, calculations = false } = {}) {
  useLook(look);
  const content = slideContent(data, { t, lang, calculations });
  // A face is fetched only once something uses it: ask for the weights the pages draw with.
  await Promise.all([400, 600].map((weight) => document.fonts?.load(`${weight} 28px ${FONT}`))).catch(() => {});
  await document.fonts?.ready;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const pages = [];
  const all = [...content.pages, ...layoutAppendix(ctx, content)];
  numberContents(all);
  for (const [i, page] of all.entries()) {
    const images = {};
    if (page.chart?.kind === 'forecast') {
      const palette = { ink: C.ink, muted: C.muted, grid: C.line, forecast: '#dc2626', plan: C.accent, t };
      images.chart = await svgImage(forecastChart(page.chart.points, palette), 760, 300).catch(() => null);
    }
    drawPage(ctx, content, page, i, { rtl: dir === 'rtl', images, total: all.length });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: W, height: H });
  }
  return { pages, title: content.heading(content.pages[2]) };
}

/** The projection summary as a PDF Blob. */
export async function slidesPdf(data, options = {}) {
  const { pages, title } = await drawSlides(data, options);
  return new Blob([pdfFromJpegs(pages, { title })], { type: 'application/pdf' });
}

// ---------------------------------------------------------------------------------------------
// The PDF: one JPEG filling each page
// ---------------------------------------------------------------------------------------------

/** A PDF text string any language can use: UTF-16BE in hex, with its byte-order mark. */
function pdfText(s) {
  let hex = 'FEFF';
  for (const unit of String(s)) {
    const code = unit.codePointAt(0);
    const units = code > 0xffff ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)] : [code];
    for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

/** `pages`: [{ bytes (a JPEG), width, height }] → the PDF's bytes, each page `PAGE` points, the picture filling it. */
export function pdfFromJpegs(pages, { title = '', page = PAGE } = {}) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const put = (part) => {
    const bytes = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n, ...parts) => {
    offsets[n] = length;
    put(`${n} 0 obj\n`);
    parts.forEach(put);
    put('\nendobj\n');
  };
  // 1 catalog, 2 page tree, 3 information; then three objects a page: the page, its drawing, its picture.
  const first = 4;
  const kids = pages.map((_, i) => `${first + i * 3} 0 R`).join(' ');
  put('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  object(3, `<< /Title ${pdfText(title)} /Producer ${pdfText('CxMissionZero')} /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
  pages.forEach((p, i) => {
    const n = first + i * 3;
    const draw = `q ${page.width} 0 0 ${page.height} 0 0 cm /P${i} Do Q`;
    object(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /P${i} ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    object(n + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    object(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`, p.bytes, '\nendstream');
  });
  const count = first + pages.length * 3;
  const xref = length;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
