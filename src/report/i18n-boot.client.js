// Runs inside the report, right after public/i18n.js (inlined together as one module by
// html-report.js): the report in the reader's language. The report carries its reader's own
// language (#report-i18n); any other one they pick comes from the reminder server, once, and is
// kept in this browser. The reader's choice in this browser wins, then the language the report was
// made in (its recipient's profile), then the browser's. Names, findings, addresses and what
// Checkmarx One wrote stay as they are.
{
  const L = t;
  const island = JSON.parse(document.getElementById('report-i18n').textContent);
  const carried = island.strings || {};
  const offered = island.languages || [];
  const has = (code) => offered.some(([known]) => known === code);
  setAvailable(offered.map(([code]) => code));

  /** The reminder server this report talks to (a reader's correction, kept in this browser, wins). */
  function server() {
    let base = '';
    try {
      base = String(JSON.parse(document.getElementById('report-data').textContent).config.relayUrl || '').replace(/\/+$/, '');
      base = localStorage.getItem(`cxReportServer:${base}`) || base;
    } catch {}
    return base.replace(/\/+$/, '');
  }

  const kept = (code) => `mz-report-words:${island.version}:${code}`;
  // Words from outside the report (the server, or this browser's storage, which another local file
  // could write to) may carry exactly the markup of their English and nothing more: a sentence is
  // put in as HTML, so a word with any other tag or attribute is left out.
  const tagsOf = (text) => (String(text).match(/<\/?[a-zA-Z][^>]*>/g) || []).map((tag) => tag.replace(/\s+/g, ' ')).sort().join('\n');
  const safe = (map) =>
    Object.fromEntries(Object.entries(map && typeof map === 'object' ? map : {}).filter(([english, out]) => typeof out === 'string' && tagsOf(english) === tagsOf(out)));
  const fetched = {};
  /** A language's words: carried, kept from before, or asked for (a few seconds at most). */
  async function words(code) {
    if (code === 'en') return {};
    if (carried[code]) return carried[code];
    if (fetched[code]) return fetched[code];
    try {
      const saved = JSON.parse(localStorage.getItem(kept(code)) || 'null');
      if (saved && typeof saved === 'object') return (fetched[code] = safe(saved));
    } catch {}
    if (!island.fetch || !server()) throw new Error(`${code}: not in this report`);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${server()}/api/relay/report-words/${encodeURIComponent(code)}`, { signal: controller?.signal });
      const body = await response.json();
      if (!response.ok || !body?.strings) throw new Error(body?.error || String(response.status));
      try {
        localStorage.setItem(kept(code), JSON.stringify(body.strings));
      } catch {}
      return (fetched[code] = safe(body.strings));
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
