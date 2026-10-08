// Runs inside the report, right after public/i18n.js (inlined together as one module by
// html-report.js): the report in the reader's language. Its words come with it (#report-i18n),
// so nothing is fetched. The reader's own choice in this browser wins, then the language the
// report was made in (its recipient's profile), then the browser's. Names, findings, addresses
// and what Checkmarx One wrote stay as they are.
{
  const island = JSON.parse(document.getElementById('report-i18n').textContent);
  const words = island.strings || {};
  const offered = (island.languages || []).filter(([code]) => code === 'en' || words[code]);
  const has = (code) => offered.some(([known]) => known === code);
  setAvailable(offered.map(([code]) => code));
  setLoader(async (code) => words[code] || {});
  let saved = null;
  try {
    saved = localStorage.getItem('mz-lang');
  } catch {}
  const browser = preferredLanguage(null);
  const first = has(saved) ? saved : has(island.default) ? island.default : has(browser) ? browser : 'en';
  /** The words report.client.js looks up (L) for what it writes itself. */
  const use = (code) => {
    window.MZReportWords = code === 'en' ? null : new Map(Object.entries(words[code] || {}));
  };
  use(first);

  const picker = document.getElementById('report-lang');
  if (picker && offered.length > 1) {
    for (const [code, name] of offered) picker.append(new Option(name, code));
    picker.value = first;
    picker.closest('label').hidden = false;
    picker.addEventListener('change', async () => {
      const code = await setLanguage(picker.value);
      use(code);
      window.MZReportRelabel?.();
    });
  }
  /** Everything the translator would look up here (scripts/i18n-report.mjs collects it). */
  window.MZReportCollect = () => collect();
  startI18n(first)
    .catch((error) => console.warn(error))
    .finally(() => window.MZReportStart?.());
}
