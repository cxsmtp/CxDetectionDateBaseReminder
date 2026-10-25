// Runs inside the report, right after public/i18n.js (inlined together as one module by
// html-report.js): the report in the reader's language. The report carries its reader's own
// language (#report-i18n); any other one they pick comes from the reminder server, once, and is
// kept in this browser. The reader's choice in this browser wins, then the language the report was
// made in (its recipient's profile), then the browser's. Names, findings, addresses and what
// Checkmarx One wrote stay as they are.
{
  const L = t;
  const island = JSON.parse(document.getElementById('report-i18n').textContent);
  const offered = Array.isArray(island.languages) ? island.languages : [];
  const has = (code) => typeof code === 'string' && offered.some(([known]) => known === code);
  setAvailable(offered.map(([code]) => code));

  /** An http(s) address without user name, query or fragment (as a reminder server's), else ''. */
  const webAddress = (value) => {
    try {
      const url = new URL(String(value ?? ''));
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return '';
      return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
      return '';
    }
  };
  /**
   * The reminder server this report talks to: the one it was sent with, or a reader's correction
   * kept in this browser (report.client.js, switchServer), when that is a web address too.
   */
  function server() {
    let base = '';
    try {
      base = String(JSON.parse(document.getElementById('report-data').textContent).config.relayUrl || '').replace(/\/+$/, '');
    } catch {}
    let corrected = '';
    try {
      corrected = webAddress(localStorage.getItem(`cxReportServer:${base}`));
    } catch {}
    return corrected || webAddress(base);
  }

  const kept = (code) => `mz-report-words:${island.version}:${code}`;
  // Words from outside the report (the server, or this browser's storage, which another local file
  // could write to) may carry exactly the markup of their English and nothing more: a sentence is
  // put in as HTML, so a word with any other tag or attribute is left out.
  // (public/i18n.js sanitises every sentence to inline markup again before it is shown.) The words
  // are kept in objects without a prototype, and names that are not wording are never copied.
  const tagsOf = (text) => (String(text).match(/<\/?[a-zA-Z][^>]*>/g) || []).map((tag) => tag.replace(/\s+/g, ' ')).sort().join('\n');
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const safe = (map, check = true) => {
    const out = Object.create(null);
    for (const [english, word] of Object.entries(map && typeof map === 'object' ? map : {})) {
      if (UNSAFE_KEYS.has(english) || typeof word !== 'string' || (check && tagsOf(english) !== tagsOf(word))) continue;
      out[english] = word;
    }
    return out;
  };
  // The report's own words (written by its server when it was made), per offered language.
  const carried = new Map(Object.entries(island.strings && typeof island.strings === 'object' ? island.strings : {}).filter(([code]) => has(code)).map(([code, map]) => [code, safe(map, false)]));
  const fetched = new Map();
  /** A language's words: carried, kept from before, or asked for (a few seconds at most). */
  async function words(code) {
    if (code === 'en') return {};
    if (!has(code)) throw new Error(`${code}: not offered in this report`);
    if (carried.has(code)) return carried.get(code);
    if (fetched.has(code)) return fetched.get(code);
    try {
      const saved = JSON.parse(localStorage.getItem(kept(code)) || 'null');
      if (saved && typeof saved === 'object') {
        const stored = safe(saved);
        fetched.set(code, stored);
        return stored;
      }
    } catch {}
    if (!island.fetch || !server()) throw new Error(`${code}: not in this report`);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && setTimeout(() => controller.abort(), 5000);
    try {
      // Asked of the reminder server only, at an http(s) address, without cookies; an answer from
      // anywhere else (a redirect to another origin) is not read.
      const target = new URL(`${server()}/api/relay/report-words/${encodeURIComponent(code)}`);
      if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error(`${code}: the reminder server address is not a web address`);
      const response = await fetch(target.href, { signal: controller?.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (response.url && new URL(response.url).origin !== target.origin) throw new Error(`${code}: answered from another address`);
      const body = await response.json();
      if (!response.ok || !body?.strings || typeof body.strings !== 'object') throw new Error(body?.error || String(response.status));
      const got = safe(body.strings);
      try {
        localStorage.setItem(kept(code), JSON.stringify(got));
      } catch {}
      fetched.set(code, got);
      return got;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  setLoader(words);

  /** The words report.client.js looks up (L) for what it writes itself. */
  const use = async (code) => {
    window.MZReportWords = code === 'en' ? null : new Map(Object.entries(await words(code).catch(() => ({}))));
  };

  let saved = null;
  try {
    saved = localStorage.getItem('mz-lang');
  } catch {}
  const browser = preferredLanguage(null);
  const first = has(saved) ? saved : has(island.default) ? island.default : has(browser) ? browser : 'en';

  const picker = document.getElementById('report-lang');
  if (picker && offered.length > 1) {
    for (const [code, name] of offered) picker.append(new Option(name, code));
    picker.closest('label').hidden = false;
    picker.addEventListener('change', async () => {
      const wanted = picker.value;
      picker.disabled = true;
      try {
        await words(wanted);
      } catch {
        picker.value = currentLanguage();
        picker.disabled = false;
        alert(L('That language could not be loaded: the reminder server did not answer. The report stays in the language it was in.'));
        return;
      }
      const code = await setLanguage(wanted);
      await use(code);
      picker.value = code;
      picker.disabled = false;
      window.MZReportRelabel?.();
    });
  }
  /** Everything the translator would look up here (scripts/i18n-report.mjs collects it). */
  window.MZReportCollect = () => collect();

  startI18n(first)
    .catch((error) => console.warn(error))
    .then(() => use(currentLanguage()))
    .finally(() => {
      if (picker) picker.value = currentLanguage();
      // The report starts by itself after a few seconds; words that came later are shown now.
      if (window.MZReportStarted?.()) window.MZReportRelabel?.();
      else window.MZReportStart?.();
    });
}
