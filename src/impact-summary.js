/**
 * The Impact page on one page, for leadership: downloaded (with the debt chart,
 * ready to print or save as PDF) or emailed each month (email clients drop
 * charts, so the email has the numbers and the table only).
 */

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }));
const cash = (n, currency) => (n === null || n === undefined ? '—' : `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${esc(currency)}`);
const day = (iso) => String(iso ?? '').slice(0, 10);
const SEV = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

/** The debt line as an inline SVG (single series: no legend; the title names it). */
export function debtChartSvg(series, { width = 680, height = 200 } = {}) {
  if (series.length < 2) return '<p style="color:#64748b;font-size:13px">The chart appears after two weeks of readings.</p>';
  const pad = { l: 44, r: 56, t: 12, b: 26 };
  const max = Math.max(1, ...series.map((p) => p.score));
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const x = (i) => pad.l + (i / (series.length - 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join('');
  const area = `${line}L${x(series.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const ticks = [0, top / 2, top].map((v) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e2e8f0" stroke-width="1"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#64748b">${num(v)}</text>`).join('');
  const last = series.at(-1);
  const lx = x(series.length - 1);
  const ly = y(last.score);
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Security debt from ${day(series[0].at)} to ${day(last.at)}: ${num(series[0].score)} to ${num(last.score)}" style="max-width:${width}px;font-family:inherit">
    ${ticks}
    <path d="${area}" fill="#4f46e5" fill-opacity="0.1"/>
    <path d="${line}" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="4" fill="#4f46e5" stroke="#fff" stroke-width="2"/>
    <text x="${lx + 8}" y="${ly + 4}" font-size="12" font-weight="600" fill="#0f172a">${num(last.score)}</text>
    <text x="${pad.l}" y="${height - 6}" font-size="11" fill="#64748b">${esc(day(series[0].at))}</text>
    <text x="${width - pad.r}" y="${height - 6}" font-size="11" fill="#64748b" text-anchor="end">${esc(day(last.at))}</text>
  </svg>`;
}

/**
 * The summary as { subject, html, text }. `email`: no chart (most email
 * clients drop SVG), and a link to the Impact page when `pageUrl` is given.
 */
export function impactSummary(impact, { appName = 'CxMissionZero', periodLabel = '', email = false, pageUrl = '', generatedAt = new Date() } = {}) {
  const m = impact.money;
  const debt = impact.debt;
  const debtLine = debt.change === null ? 'No open findings at the start of the period.' : `${debt.change <= 0 ? 'Down' : 'Up'} ${Math.abs(debt.change)}% (from ${num(debt.start)} to ${num(debt.now)})${debt.zeroBy ? `; at this pace it reaches zero by ${esc(debt.zeroBy)}` : ''}.`;
  const tiles = [
    ['Hours saved', `${num(impact.hours.total)} h`, `${num(impact.hours.triage)} h triage, ${num(impact.hours.fix)} h fixing`],
    ['Value of that time', m.value === null ? 'Set an hourly cost' : cash(m.net ?? m.value, m.currency), m.value === null ? 'Settings → AI & credits → Impact' : m.cost === null ? 'before the cost of credits' : `${cash(m.value, m.currency)} saved, ${cash(m.cost, m.currency)} in credits`],
    ['Noise removed', num(impact.noiseRemoved), 'findings AI Triage showed not exploitable'],
    ['Security debt', debt.change === null ? '—' : `${debt.change > 0 ? '+' : ''}${debt.change}%`, debt.zeroBy ? `zero by ${esc(debt.zeroBy)} at this pace` : 'open findings, weighted by severity'],
  ];
  const tileHtml = tiles
    .map(([label, value, note]) => `<td style="width:25%;padding:12px;border:1px solid #e2e8f0;border-radius:8px;vertical-align:top"><div style="font-size:12px;color:#64748b">${esc(label)}</div><div style="font-size:24px;font-weight:700;color:#0f172a;margin:4px 0">${esc(value)}</div><div style="font-size:12px;color:#64748b">${esc(note)}</div></td>`)
    .join('');
  const ttf = impact.timeToFix
    .filter((r) => r.aiCount || r.manualCount)
    .map((r) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${SEV[r.severity]}</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right">${r.ai === null ? '—' : `${num(r.ai)} days`} <span style="color:#64748b">(${r.aiCount})</span></td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right">${r.manual === null ? '—' : `${num(r.manual)} days`} <span style="color:#64748b">(${r.manualCount})</span></td></tr>`)
    .join('');
  const top = impact.byProject.filter((p) => p.aiFixed || p.notExploitable || p.manualFixed).slice(0, 8)
    .map((p) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${esc(p.projectName || p.projectId)}</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right">${p.aiFixed}</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right">${p.notExploitable}</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right">${p.manualFixed}</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right">${p.open}</td></tr>`)
    .join('');
  const s = impact.settings;
  const how = [
    `Hours saved: ${num(impact.credits.triage)} Checkmarx One results triaged by AI × ${s.triageMinutes} min, plus ${impact.aiFixed} AI fixes × ${s.fixMinutes} min. A fix counts only once Checkmarx One no longer reports the finding.`,
    m.value === null ? 'Money: set an hourly cost and a price per credit to see it.' : `Money: hours × ${cash(s.hourlyRate, m.currency)} an hour${m.cost === null ? '' : `, less ${num(impact.credits.total)} credits × ${cash(s.creditPrice, m.currency)}`}.`,
    'Security debt: open Checkmarx One results weighted by severity (critical 10, high 5, medium 2, low 1); rows that share a result count once.',
    'Time to fix: days from first detection until Checkmarx One no longer reports it, AI-fixed against fixed by hand over the same period (median, with how many).',
    impact.partial ? `Readings start on ${esc(day(impact.since))}: the period before that is not included.` : '',
  ].filter(Boolean);
  const title = `${appName}: impact${periodLabel ? `, ${periodLabel}` : ''}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>@media print{a{color:inherit}} body{margin:0;background:#f8fafc}</style></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<div style="max-width:760px;margin:0 auto;padding:24px;background:#fff">
  <h1 style="font-size:20px;margin:0 0 4px">${esc(title)}</h1>
  <p style="margin:0 0 16px;color:#64748b;font-size:13px">${esc(day(impact.from))} to ${esc(day(impact.to))} · prepared ${esc(day(generatedAt.toISOString()))}</p>
  <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px;margin:0 -8px"><tr>${tileHtml}</tr></table>
  <h2 style="font-size:15px;margin:20px 0 4px">Security debt, week by week</h2>
  <p style="margin:0 0 8px;color:#475569;font-size:13px">${debtLine}</p>
  ${email ? '' : debtChartSvg(impact.series)}
  <h2 style="font-size:15px;margin:20px 0 8px">Time to fix, AI-assisted and by hand</h2>
  ${ttf ? `<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left;padding:6px 8px;color:#64748b;font-weight:600">Severity</th><th style="text-align:right;padding:6px 8px;color:#64748b;font-weight:600">With AI</th><th style="text-align:right;padding:6px 8px;color:#64748b;font-weight:600">By hand</th></tr></thead><tbody>${ttf}</tbody></table>` : '<p style="color:#64748b;font-size:13px">No fixes in this period yet.</p>'}
  ${top ? `<h2 style="font-size:15px;margin:20px 0 8px">Projects</h2><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left;padding:6px 8px;color:#64748b;font-weight:600">Project</th><th style="text-align:right;padding:6px 8px;color:#64748b;font-weight:600">Fixed with AI</th><th style="text-align:right;padding:6px 8px;color:#64748b;font-weight:600">Not exploitable</th><th style="text-align:right;padding:6px 8px;color:#64748b;font-weight:600">Fixed by hand</th><th style="text-align:right;padding:6px 8px;color:#64748b;font-weight:600">Open</th></tr></thead><tbody>${top}</tbody></table>` : ''}
  <h2 style="font-size:13px;margin:20px 0 4px;color:#475569">How these are worked out</h2>
  <ul style="margin:0;padding-left:18px;color:#64748b;font-size:12px;line-height:1.5">${how.map((line) => `<li>${line}</li>`).join('')}</ul>
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
