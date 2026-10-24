/**
 * The Impact page on one page, for leadership: downloaded (with the debt chart,
 * ready to print or save as PDF) or emailed each month (email clients drop
 * charts, so the email has the numbers and the table only).
 */

import { NEXTGEN_ACCENTS, lookPalette, reportLook } from '../public/look.js';
import { formatMoney } from './money.js';
import { safeUrl } from './template.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }));
const cash = (n, currency) => esc(formatMoney(n, currency, { digits: 0 }));
/** A unit price (an hourly cost, a credit): to the cent. */
const price = (n, currency) => esc(formatMoney(n, currency, { digits: 2 }));
const day = (iso) => String(iso ?? '').slice(0, 10);
const PERSONAL = { currency: 'currency', hourlyRate: 'hourly cost', creditPrice: 'price of one credit', triageMinutes: 'minutes to triage', fixMinutes: 'minutes to fix' };
const SEV = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

/**
 * The summary's colours: the classic ones, or the reader's look (public/look.js) on a light page, with the
 * look's band at the top and its face for the title. Set for each summary (it is made in one go).
 */
const CLASSIC = { ink: '#0f172a', muted: '#64748b', soft: '#475569', line: '#e2e8f0', rule: '#f1f5f9', accent: '#2856c9', bg: '#f8fafc', surface: '#fff', head: '', headInk: '', display: '' };
let C = CLASSIC;
function summaryColours(look) {
  const { look: name, ui, accent } = reportLook(look);
  if (ui !== 'nextgen') return CLASSIC;
  const p = lookPalette(name, accent);
  if (!p) {
    const ink = NEXTGEN_ACCENTS[accent][0];
    return { ink: '#1e2226', muted: '#67625a', soft: '#4a453d', line: '#e3ddd0', rule: '#ebe6da', accent: ink, bg: '#f3f0e8', surface: '#fbfaf6', head: '#1b1f23', headInk: '#ebe6dc', display: '"Fraunces", Georgia, serif' };
  }
  const c = p.light;
  return { ink: c.ink, muted: c.muted, soft: c.muted, line: c.line, rule: c.surface2, accent: c.accent, bg: c.bg, surface: c.surface, head: p.head, headInk: p.headInk, display: p.display };
}

/** The debt line as an inline SVG (single series: no legend; the title names it). */
export function debtChartSvg(series, { width = 680, height = 200 } = {}) {
  if (series.length < 2) return `<p style="color:${C.muted};font-size:13px">The chart appears after two weeks of readings.</p>`;
  const pad = { l: 44, r: 56, t: 12, b: 26 };
  const max = Math.max(1, ...series.map((p) => p.score));
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const x = (i) => pad.l + (i / (series.length - 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join('');
  const area = `${line}L${x(series.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const ticks = [0, top / 2, top].map((v) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="${C.line}" stroke-width="1"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${C.muted}">${num(v)}</text>`).join('');
  const last = series.at(-1);
  const lx = x(series.length - 1);
  const ly = y(last.score);
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Security debt from ${day(series[0].at)} to ${day(last.at)}: ${num(series[0].score)} to ${num(last.score)}" style="max-width:${width}px;font-family:inherit">
    ${ticks}
    <path d="${area}" fill="${C.accent}" fill-opacity="0.1"/>
    <path d="${line}" fill="none" stroke="${C.accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="4" fill="${C.accent}" stroke="${C.surface}" stroke-width="2"/>
    <text x="${lx + 8}" y="${ly + 4}" font-size="12" font-weight="600" fill="${C.ink}">${num(last.score)}</text>
    <text x="${pad.l}" y="${height - 6}" font-size="11" fill="${C.muted}">${esc(day(series[0].at))}</text>
    <text x="${width - pad.r}" y="${height - 6}" font-size="11" fill="${C.muted}" text-anchor="end">${esc(day(last.at))}</text>
  </svg>`;
}

/**
 * The summary as { subject, html, text }. `email`: no chart (most email
 * clients drop SVG), and a link to the Impact page when `pageUrl` is given.
 */
export function impactSummary(impact, { appName = 'CxMissionZero', periodLabel = '', email = false, pageUrl = '', generatedAt = new Date(), personal = null, look = null } = {}) {
  // Only a web address becomes the link (never javascript: or data:).
  pageUrl = safeUrl(pageUrl);
  C = summaryColours(look);
  const m = impact.money;
  const debt = impact.debt;
  const debtLine = debt.change === null ? 'No open findings at the start of the period.' : `${debt.change <= 0 ? 'Down' : 'Up'} ${Math.abs(debt.change)}% (from ${num(debt.start)} to ${num(debt.now)})${debt.zeroBy ? `; at this pace it reaches zero by ${esc(debt.zeroBy)}` : ''}.`;
  const tiles = [
    ['Hours saved', `${num(impact.hours.total)} h`, `${num(impact.hours.triage)} h triage, ${num(impact.hours.fix)} h fixing`],
    [m.value !== null && m.cost !== null ? 'Saved, after credits' : 'Value of that time', m.value === null ? 'Set an hourly cost' : cash(m.net ?? m.value, m.currency), m.value === null ? 'Settings → AI & credits → Impact' : m.cost === null ? 'before the cost of credits' : `${cash(m.value, m.currency)} saved, ${cash(m.cost, m.currency)} in credits`],
    ['Noise removed', num(impact.noiseRemoved), 'findings AI Triage showed not exploitable'],
    ['Security debt', debt.change === null ? '—' : `${debt.change > 0 ? '+' : ''}${debt.change}%`, debt.zeroBy ? `zero by ${esc(debt.zeroBy)} at this pace` : 'open findings, weighted by severity'],
  ];
  const tileHtml = tiles
    .map(([label, value, note]) => `<td style="width:25%;padding:12px;border:1px solid ${C.line};border-radius:8px;vertical-align:top"><div style="font-size:12px;color:${C.muted}">${esc(label)}</div><div style="font-size:24px;font-weight:700;color:${C.ink};margin:4px 0">${esc(value)}</div><div style="font-size:12px;color:${C.muted}">${esc(note)}</div></td>`)
    .join('');
  const ttf = impact.timeToFix
    .filter((r) => r.aiCount || r.manualCount)
    .map((r) => `<tr><td style="padding:6px 8px;border-bottom:1px solid ${C.rule}">${SEV[r.severity]}</td><td style="padding:6px 8px;border-bottom:1px solid ${C.rule};text-align:right">${r.ai === null ? '—' : `${num(r.ai)} days`} <span style="color:${C.muted}">(${r.aiCount})</span></td><td style="padding:6px 8px;border-bottom:1px solid ${C.rule};text-align:right">${r.manual === null ? '—' : `${num(r.manual)} days`} <span style="color:${C.muted}">(${r.manualCount})</span></td></tr>`)
    .join('');
  const top = impact.byProject.filter((p) => p.aiFixed || p.notExploitable || p.manualFixed).slice(0, 8)
    .map((p) => `<tr><td style="padding:6px 8px;border-bottom:1px solid ${C.rule};overflow-wrap:anywhere">${esc(p.projectName || p.projectId)}</td><td style="padding:6px 8px;border-bottom:1px solid ${C.rule};text-align:right">${p.aiFixed}</td><td style="padding:6px 8px;border-bottom:1px solid ${C.rule};text-align:right">${p.notExploitable}</td><td style="padding:6px 8px;border-bottom:1px solid ${C.rule};text-align:right">${p.manualFixed}</td><td style="padding:6px 8px;border-bottom:1px solid ${C.rule};text-align:right">${p.open}</td></tr>`)
    .join('');
  const s = impact.settings;
  const how = [
    `Hours saved: ${num(impact.credits.triage)} Checkmarx One results triaged by AI × ${s.triageMinutes} min, plus ${impact.aiFixed} AI fixes × ${s.fixMinutes} min. A fix counts only once Checkmarx One no longer reports the finding.`,
    m.value === null ? 'Money: set an hourly cost and a price per credit to see it.' : `Money: hours × ${price(s.hourlyRate, m.currency)} an hour${m.cost === null ? '' : `, less ${num(impact.credits.total)} credits × ${price(s.creditPrice, m.currency)}`}.`,
    'Security debt: open Checkmarx One results weighted by severity (critical 10, high 5, medium 2, low 1); rows that share a result count once.',
    'Time to fix: days from first detection until Checkmarx One no longer reports it, AI-fixed against fixed by hand over the same period (median, with how many).',
    personal ? `Personal figures from the reader's profile: ${personal.map((k) => PERSONAL[k]).join(', ')}.` : '',
    impact.partial ? `Readings start on ${esc(day(impact.since))}: the period before that is not included.` : '',
  ].filter(Boolean);
  const title = `${appName}: impact${periodLabel ? `, ${periodLabel}` : ''}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>@media print{a{color:inherit}} body{margin:0;background:${C.bg}}</style></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.ink}">
<div style="max-width:760px;margin:0 auto;padding:24px;background:${C.surface}">
  ${C.head ? `<div style="margin:-24px -24px 16px;padding:20px 24px 16px;background:${C.head};color:${C.headInk};border-bottom:2px solid ${C.accent}">` : ''}
  <h1 style="font-size:20px;margin:0 0 4px;overflow-wrap:anywhere${C.display ? `;font-family:${esc(C.display)};font-weight:500` : ''}">${esc(title)}</h1>
  <p style="margin:0${C.head ? '' : ' 0 16px'};color:${C.head ? C.headInk : C.muted};${C.head ? 'opacity:.8;' : ''}font-size:13px">${esc(day(impact.from))} to ${esc(day(impact.to))} · prepared ${esc(day(generatedAt.toISOString()))}</p>${C.head ? '</div>' : ''}
  <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px;margin:0 -8px"><tr>${tileHtml}</tr></table>
  <h2 style="font-size:15px;margin:20px 0 4px">Security debt, week by week</h2>
  <p style="margin:0 0 8px;color:${C.soft};font-size:13px">${debtLine}</p>
  ${email ? '' : debtChartSvg(impact.series)}
  <h2 style="font-size:15px;margin:20px 0 8px">Time to fix, AI-assisted and by hand</h2>
  ${ttf ? `<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left;padding:6px 8px;color:${C.muted};font-weight:600">Severity</th><th style="text-align:right;padding:6px 8px;color:${C.muted};font-weight:600">With AI</th><th style="text-align:right;padding:6px 8px;color:${C.muted};font-weight:600">By hand</th></tr></thead><tbody>${ttf}</tbody></table>` : '<p style="color:${C.muted};font-size:13px">No fixes in this period yet.</p>'}
  ${top ? `<h2 style="font-size:15px;margin:20px 0 8px">Projects</h2><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left;padding:6px 8px;color:${C.muted};font-weight:600">Project</th><th style="text-align:right;padding:6px 8px;color:${C.muted};font-weight:600">Fixed with AI</th><th style="text-align:right;padding:6px 8px;color:${C.muted};font-weight:600">Not exploitable</th><th style="text-align:right;padding:6px 8px;color:${C.muted};font-weight:600">Fixed by hand</th><th style="text-align:right;padding:6px 8px;color:${C.muted};font-weight:600">Open</th></tr></thead><tbody>${top}</tbody></table>` : ''}
  <h2 style="font-size:13px;margin:20px 0 4px;color:${C.soft}">How these are worked out</h2>
  <ul style="margin:0;padding-left:18px;color:${C.muted};font-size:12px;line-height:1.5">${how.map((line) => `<li>${line}</li>`).join('')}</ul>
  ${email && pageUrl ? `<p style="margin:16px 0 0;font-size:13px"><a href="${esc(pageUrl)}">Open the Impact page</a> for the chart and every project.</p>` : ''}
</div></body></html>`;
  const text = [
    title,
    `${day(impact.from)} to ${day(impact.to)}`,
    '',
    ...tiles.map(([label, value, note]) => `${label}: ${value} (${note})`),
    '',
    `Security debt: ${debtLine}`,
    ...impact.timeToFix.filter((r) => r.aiCount || r.manualCount).map((r) => `Time to fix, ${SEV[r.severity]}: with AI ${r.ai ?? '—'} days (${r.aiCount}), by hand ${r.manual ?? '—'} days (${r.manualCount})`),
    '',
    ...how.map((line) => `- ${line.replace(/<[^>]+>/g, '')}`),
    ...(pageUrl ? ['', pageUrl] : []),
  ].join('\n');
  return { subject: title, html, text };
}
