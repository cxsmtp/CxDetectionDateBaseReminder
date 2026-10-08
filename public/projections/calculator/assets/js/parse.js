/*
 * parse.js — turn a Checkmarx One export into a normalised weekly series.
 *
 * The two exports the calculator expects arrive in different shapes, and the
 * parser handles both without being told which is which:
 *
 *   wide  Week End Date | Info | Low | Medium | High | Critical
 *   long  Week End Date | Severity | Total Vulnerabilities
 *
 * Output shape:
 *   { weeks: ['2026-06-20', ...],
 *     bySeverity: { Critical: [n,...], High: [...], Medium, Low, Info },
 *     meta: { sheet, layout, exportedAt, filters }, warnings: [] }
 */
window.CxParse = (function () {
  'use strict';

  const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];

  const SEVERITY_ALIASES = {
    critical: 'Critical', crit: 'Critical',
    high: 'High',
    medium: 'Medium', med: 'Medium', moderate: 'Medium',
    low: 'Low',
    info: 'Info', informational: 'Info', information: 'Info', note: 'Info',
  };

  // Checkmarx exports prefix severities for sort order ("E. Critical"); drop it.
  function normaliseSeverity(value) {
    if (value == null) return null;
    const cleaned = String(value)
      .replace(/^\s*[A-Za-z0-9]{1,2}\s*[.)-]\s*/, '')
      .trim()
      .toLowerCase();
    return SEVERITY_ALIASES[cleaned] || null;
  }

  const pad = (n) => String(n).padStart(2, '0');

  function toIsoWeek(value) {
    if (value instanceof Date && !isNaN(value)) {
      return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    }
    if (typeof value === 'number' && value > 20000 && value < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
      return toIsoWeek(d);
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return null;
      const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      const parsed = new Date(text);
      if (!isNaN(parsed)) {
        return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
      }
    }
    return null;
  }

  const isDateish = (v) => toIsoWeek(v) !== null && !(typeof v === 'number' && v < 20000);

  function toNumber(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const n = Number(String(value).replace(/[\s,]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  const looksLikeDateHeader = (v) =>
    typeof v === 'string' && /(week|date|period|day|month|ending)/i.test(v);

  const looksLikeSeverityHeader = (v) =>
    typeof v === 'string' && /severity|risk|level/i.test(v);

  const looksLikeValueHeader = (v) =>
    typeof v === 'string' && /(count|total|vulnerab|findings|number|amount|value|issues)/i.test(v);

  /* ------------------------------------------------------------ provenance -- */

  // The "Filters" tab of a Checkmarx export records when and how it was pulled.
  function readProvenance(sheets) {
    const out = { exportedAt: null, filters: [] };
    for (const sheet of sheets) {
      for (const row of sheet.rows) {
        if (!row || !row.length) continue;
        const label = typeof row[0] === 'string' ? row[0].trim().toLowerCase() : '';
        if (label === 'date exported' && row[1] != null) {
          out.exportedAt = row[1] instanceof Date ? row[1].toISOString() : String(row[1]);
        }
        // ID | Field | Operator | DateLiteral | Value1 | Value2
        const isFilterRow = typeof row[0] === 'string' && /^[A-Za-z]{1,3}\d*$/.test(row[0].trim())
          && typeof row[1] === 'string' && row[1].trim() && row[2] != null;
        if (isFilterRow && row[1].trim().toLowerCase() !== 'field') {
          const value = [row[4], row[5]].filter((v) => v != null && v !== '').join(' – ');
          out.filters.push({ field: String(row[1]).trim(), operator: String(row[2]).trim(), value });
        }
      }
    }
    return out;
  }

  /* --------------------------------------------------------------- layouts -- */

  function detectWide(rows) {
    for (let r = 0; r < Math.min(rows.length, 25); r++) {
      const header = rows[r] || [];
      const severityColumns = [];
      header.forEach((cell, c) => {
        const sev = normaliseSeverity(cell);
        if (sev) severityColumns.push({ column: c, severity: sev });
      });
      if (severityColumns.length < 2) continue;

      const taken = new Set(severityColumns.map((s) => s.column));
      let dateColumn = header.findIndex((cell, c) => !taken.has(c) && looksLikeDateHeader(cell));
      if (dateColumn < 0) {
        // Fall back to the first column below the header that holds dates.
        const probe = rows[r + 1] || [];
        dateColumn = probe.findIndex((cell, c) => !taken.has(c) && isDateish(cell));
      }
      if (dateColumn < 0) continue;
      return { headerRow: r, dateColumn, severityColumns };
    }
    return null;
  }

  function detectLong(rows) {
    for (let r = 0; r < Math.min(rows.length, 25); r++) {
      const header = rows[r] || [];
      if (header.length < 3) continue;

      let severityColumn = header.findIndex(looksLikeSeverityHeader);
      let dateColumn = header.findIndex(looksLikeDateHeader);
      let valueColumn = header.findIndex((cell, c) =>
        c !== severityColumn && c !== dateColumn && looksLikeValueHeader(cell));

      // Header names are not guaranteed; confirm against the first data row.
      const probe = rows[r + 1] || [];
      if (severityColumn < 0) severityColumn = probe.findIndex((cell) => normaliseSeverity(cell));
      if (dateColumn < 0) dateColumn = probe.findIndex((cell) => isDateish(cell));
      if (valueColumn < 0) {
        valueColumn = probe.findIndex((cell, c) =>
          c !== severityColumn && c !== dateColumn && toNumber(cell) !== null);
      }
      if (severityColumn < 0 || dateColumn < 0 || valueColumn < 0) continue;
      if (!normaliseSeverity(probe[severityColumn]) || !isDateish(probe[dateColumn])) continue;

      return { headerRow: r, dateColumn, severityColumn, valueColumn };
    }
    return null;
  }

  /* --------------------------------------------------------------- reading -- */

  function blankSeries() {
    const out = {};
    for (const s of SEVERITIES) out[s] = new Map(); // week -> value
    return out;
  }

  function collect(sheet) {
    const rows = sheet.rows || [];
    const cells = blankSeries();
    const seen = new Set();
    let layout = null;

    const wide = detectWide(rows);
    if (wide) {
      layout = 'wide';
      for (let r = wide.headerRow + 1; r < rows.length; r++) {
        const row = rows[r] || [];
        const week = toIsoWeek(row[wide.dateColumn]);
        if (!week) continue;
        seen.add(week);
        for (const { column, severity } of wide.severityColumns) {
          const value = toNumber(row[column]);
          if (value === null) continue;
          cells[severity].set(week, (cells[severity].get(week) || 0) + value);
        }
      }
    } else {
      const long = detectLong(rows);
      if (!long) return null;
      layout = 'long';
      for (let r = long.headerRow + 1; r < rows.length; r++) {
        const row = rows[r] || [];
        const week = toIsoWeek(row[long.dateColumn]);
        const severity = normaliseSeverity(row[long.severityColumn]);
        const value = toNumber(row[long.valueColumn]);
        if (!week || !severity || value === null) continue;
        seen.add(week);
        cells[severity].set(week, (cells[severity].get(week) || 0) + value);
      }
    }

    if (!seen.size) return null;

    const weeks = Array.from(seen).sort();
    const bySeverity = {};
    for (const s of SEVERITIES) bySeverity[s] = weeks.map((w) => cells[s].get(w) ?? 0);
    return { weeks, bySeverity, layout, sheet: sheet.name };
  }

  /**
   * Parse a workbook (array of {name, rows}) into a weekly series.
   * Picks the first sheet that yields data; "Filters"-style tabs are skipped
   * automatically because they contain no severity columns.
   */
  function parseWorkbook(sheets, fileName) {
    const warnings = [];
    let series = null;
    for (const sheet of sheets) {
      series = collect(sheet);
      if (series) break;
    }
    if (!series) {
      throw new Error(
        `Could not find weekly severity data in "${fileName}". Expected either ` +
        'a column per severity, or Date / Severity / Count columns.'
      );
    }

    const provenance = readProvenance(sheets);
    const present = SEVERITIES.filter((s) => series.bySeverity[s].some((v) => v > 0));
    if (present.length < SEVERITIES.length) {
      const missing = SEVERITIES.filter((s) => !present.includes(s));
      warnings.push(`No data for ${missing.join(', ')} — treated as zero.`);
    }
    if (series.weeks.length < 2) {
      warnings.push('Only one week of data — trend and forecast need at least two.');
    }

    return {
      weeks: series.weeks,
      bySeverity: series.bySeverity,
      meta: {
        fileName,
        sheet: series.sheet,
        layout: series.layout,
        exportedAt: provenance.exportedAt,
        filters: provenance.filters,
      },
      warnings,
    };
  }

  /**
   * Guess whether a file holds the open backlog or the fixed-per-week flow.
   * Filename wins; the "Status = Fixed" filter row is the fallback.
   */
  function guessKind(fileName, sheets) {
    const name = (fileName || '').toLowerCase();
    if (/(fixed|resolved|closed|remediated|burn)/.test(name)) return 'fixed';
    if (/(total|open|backlog|outstanding|all)/.test(name)) return 'total';

    for (const sheet of sheets || []) {
      for (const row of sheet.rows || []) {
        const joined = row.filter((v) => typeof v === 'string').join('|').toLowerCase();
        if (/status/.test(joined) && /fixed/.test(joined)) return 'fixed';
      }
    }
    return null;
  }

  return { SEVERITIES, parseWorkbook, guessKind, normaliseSeverity, toIsoWeek };
})();
