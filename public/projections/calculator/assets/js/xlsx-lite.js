/*
 * xlsx-lite — a dependency-free .xlsx reader.
 *
 * An .xlsx file is a ZIP container of XML parts. This module unzips it with the
 * platform's own DecompressionStream (no bundled inflate implementation, no
 * third-party library) and reads the few parts we care about:
 *
 *   xl/workbook.xml            sheet names + relationship ids
 *   xl/_rels/workbook.xml.rels rId -> worksheet part
 *   xl/sharedStrings.xml       the string table cells point into
 *   xl/styles.xml              number formats, so date cells come back as dates
 *   xl/worksheets/sheetN.xml   the cells themselves
 *
 * Everything is exposed as CxXlsx.readWorkbook(arrayBuffer) -> [{name, rows}],
 * where rows is an array of arrays of primitives (string | number | Date | null).
 */
window.CxXlsx = (function () {
  'use strict';

  /* ---------------------------------------------------------------- unzip -- */

  const SIG_EOCD = 0x06054b50;
  const SIG_EOCD64_LOCATOR = 0x07064b50;
  const SIG_CDIR = 0x02014b50;

  function findEocd(view) {
    // The end-of-central-directory record lives in the last 64KB + comment.
    const start = Math.max(0, view.byteLength - 66_000);
    for (let i = view.byteLength - 22; i >= start; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) return i;
    }
    throw new Error('Not a ZIP archive (no end-of-central-directory record found).');
  }

  function centralDirectory(buf) {
    const view = new DataView(buf);
    const eocd = findEocd(view);
    let count = view.getUint16(eocd + 10, true);
    let cdOffset = view.getUint32(eocd + 16, true);

    // ZIP64: the 32-bit fields are saturated and the real values live elsewhere.
    if (cdOffset === 0xffffffff || count === 0xffff) {
      for (let i = eocd - 20; i >= 0; i--) {
        if (view.getUint32(i, true) === SIG_EOCD64_LOCATOR) {
          const z64 = Number(view.getBigUint64(i + 8, true));
          count = Number(view.getBigUint64(z64 + 32, true));
          cdOffset = Number(view.getBigUint64(z64 + 48, true));
          break;
        }
      }
    }

    const entries = [];
    let p = cdOffset;
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== SIG_CDIR) break;
      const method = view.getUint16(p + 10, true);
      const compressedSize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
      entries.push({ name, method, compressedSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error(
        'This browser cannot unzip .xlsx files (DecompressionStream is unavailable). ' +
        'Use Chrome 80+, Edge 80+, Firefox 113+ or Safari 16.4+, or upload CSV instead.'
      );
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buf) {
    const view = new DataView(buf);
    const files = new Map();
    for (const entry of centralDirectory(buf)) {
      const lo = entry.localOffset;
      const nameLen = view.getUint16(lo + 26, true);
      const extraLen = view.getUint16(lo + 28, true);
      const dataStart = lo + 30 + nameLen + extraLen;
      const raw = new Uint8Array(buf, dataStart, entry.compressedSize);
      if (entry.method === 0) files.set(entry.name, raw);
      else if (entry.method === 8) files.set(entry.name, await inflateRaw(raw));
      // Other methods (bzip2, lzma) are never produced by Excel; skip them.
    }
    return files;
  }

  /* ------------------------------------------------------------------ xml -- */

  function parseXml(bytes) {
    const text = new TextDecoder().decode(bytes);
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Malformed XML inside the workbook.');
    return doc;
  }

  // Element lookup that ignores namespace prefixes (Excel is inconsistent about them).
  const tags = (node, name) => Array.from(node.getElementsByTagName('*')).filter(
    (el) => el.localName === name
  );
  const firstTag = (node, name) => tags(node, name)[0] || null;

  /* -------------------------------------------------------------- numbers -- */

  // Built-in number-format ids that mean "this is a date or a time".
  const BUILTIN_DATE_FORMATS = new Set([
    14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
    45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
  ]);

  function looksLikeDateFormat(code) {
    // Strip quoted literals and colour/condition blocks before sniffing for d/m/y.
    const bare = String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    return /[ymdhs]/i.test(bare) && !/^[^ymdhs]*$/i.test(bare);
  }

  function readStyles(files) {
    const part = files.get('xl/styles.xml');
    if (!part) return [];
    const doc = parseXml(part);

    const custom = new Map();
    for (const fmt of tags(doc, 'numFmt')) {
      custom.set(Number(fmt.getAttribute('numFmtId')), fmt.getAttribute('formatCode') || '');
    }

    const cellXfs = firstTag(doc, 'cellXfs');
    if (!cellXfs) return [];
    return tags(cellXfs, 'xf').map((xf) => {
      const id = Number(xf.getAttribute('numFmtId') || 0);
      if (custom.has(id)) return looksLikeDateFormat(custom.get(id));
      return BUILTIN_DATE_FORMATS.has(id);
    });
  }

  // Excel stores dates as days since 1899-12-30 (its 1900 leap-year bug included).
  const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
  function serialToDate(serial) {
    return new Date(EXCEL_EPOCH_UTC + Math.round(serial * 86400000));
  }

  function readSharedStrings(files) {
    const part = files.get('xl/sharedStrings.xml');
    if (!part) return [];
    const doc = parseXml(part);
    return tags(doc, 'si').map((si) => {
      // A shared string may be split across several <t> runs.
      const runs = tags(si, 't').filter((t) => t.parentElement.localName !== 'rPh');
      return runs.map((t) => t.textContent).join('');
    });
  }

  /* --------------------------------------------------------------- sheets -- */

  const columnIndex = (ref) => {
    const letters = String(ref).replace(/[^A-Z]/gi, '').toUpperCase();
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };

  function readSheet(doc, shared, dateStyles) {
    const rows = [];
    for (const row of tags(doc, 'row')) {
      const cells = [];
      let cursor = 0;
      for (const c of tags(row, 'c')) {
        const at = c.hasAttribute('r') ? columnIndex(c.getAttribute('r')) : cursor;
        while (cells.length < at) cells.push(null);
        cursor = at + 1;

        const type = c.getAttribute('t') || 'n';
        const styleIndex = Number(c.getAttribute('s') || -1);
        let value = null;

        if (type === 'inlineStr') {
          const is = firstTag(c, 'is');
          value = is ? tags(is, 't').map((t) => t.textContent).join('') : null;
        } else {
          const v = firstTag(c, 'v');
          const text = v ? v.textContent : null;
          if (text === null || text === '') value = null;
          else if (type === 's') value = shared[Number(text)] ?? null;
          else if (type === 'str' || type === 'e') value = text;
          else if (type === 'b') value = text === '1';
          else {
            const num = Number(text);
            value = Number.isFinite(num)
              ? (dateStyles[styleIndex] && num > 0 ? serialToDate(num) : num)
              : text;
          }
        }
        cells.push(value);
      }
      rows.push(cells);
    }
    return rows;
  }

  async function readWorkbook(arrayBuffer) {
    const files = await unzip(arrayBuffer);
    const workbookPart = files.get('xl/workbook.xml');
    if (!workbookPart) throw new Error('Not an .xlsx workbook (xl/workbook.xml is missing).');

    const shared = readSharedStrings(files);
    const dateStyles = readStyles(files);

    // rId -> part path
    const rels = new Map();
    const relsPart = files.get('xl/_rels/workbook.xml.rels');
    if (relsPart) {
      for (const rel of tags(parseXml(relsPart), 'Relationship')) {
        let target = rel.getAttribute('Target') || '';
        target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
        rels.set(rel.getAttribute('Id'), 'xl/' + target);
      }
    }

    const sheets = [];
    const wb = parseXml(workbookPart);
    tags(wb, 'sheet').forEach((sheet, i) => {
      const name = sheet.getAttribute('name') || `Sheet${i + 1}`;
      const rid = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
        || sheet.getAttribute('r:id');
      const path = (rid && rels.get(rid)) || `xl/worksheets/sheet${i + 1}.xml`;
      const part = files.get(path);
      if (!part) return;
      sheets.push({ name, rows: readSheet(parseXml(part), shared, dateStyles) });
    });

    if (!sheets.length) throw new Error('The workbook contains no readable worksheets.');
    return sheets;
  }

  /* ------------------------------------------------------------------ csv -- */

  function readCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === ',') { row.push(field); field = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    // Coerce plain numbers so the parser sees the same shapes it gets from .xlsx.
    return rows.map((r) => r.map((cell) => {
      const trimmed = cell.trim();
      if (trimmed === '') return null;
      const numeric = Number(trimmed.replace(/,/g, ''));
      return trimmed !== '' && Number.isFinite(numeric) && /^[-+]?[\d,]*\.?\d+$/.test(trimmed)
        ? numeric
        : trimmed;
    }));
  }

  async function readFile(file) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
      const text = await file.text();
      const body = name.endsWith('.tsv') ? text.replace(/\t/g, ',') : text;
      return [{ name: file.name, rows: readCsv(body) }];
    }
    return readWorkbook(await file.arrayBuffer());
  }

  return { readWorkbook, readCsv, readFile };
})();
