// Cx Credits Calculator: the script inside a projection report made with its levers. It reads the report's
// figures (the JSON in #cx-live), and when the customer moves a lever works them out again with the
// calculator's own model (levers.js) and writes the report's body again (report.js). Nothing is sent
// anywhere: the file's content security policy allows this script alone and no connection at all.
// "Download my version" saves the report as it now stands, with the plan as sent kept to go back to.

import { buildReport, reportFileName, reportMain } from './report.js';
import { slidesFileName, slidesPdf } from './slides.js';
import { changePeriod, leverData } from './levers.js';
import { amount, wholeNumber } from './model.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

/** One lever moved: the inputs with its new value (`key` is the control's data-lever). */
export function applyLever(inputs, key, value, checked) {
  const next = clone(inputs);
  const [kind, id] = key.split(/\.(.*)/s);
  const plan = next.tr?.plan;
  const f = next.fusion;
  const project = (k) => f?.projects.find((p) => p.key === Number(k));
  switch (kind) {
    case 'sel': if (plan) plan.selected[id] = wholeNumber(value) ?? 0; break;
    case 'fp': if (plan) plan.fpPercent[id] = amount(value) ?? 0; break;
    case 'tc': if (plan) plan.triageCost[id] = amount(value); break;
    case 'rc': if (plan) plan.remediationCost[id] = amount(value); break;
    case 'future': if (plan) plan.includeFuture = Boolean(checked); break;
    case 'ai': if (plan) plan.aiDeclinePercent = amount(value) ?? 0; break;
    case 'up': if (plan) plan.fusionUpliftPercent = amount(value) ?? 0; break;
    case 'months': return changePeriod(next, value);
    case 'extra': next.totals.extraPercent = amount(value) ?? 0; break;
    case 'bundle': next.totals.bundleCredits = wholeNumber(value) || null; break;
    case 'rate': { const m = f?.settings.models.find((x) => x.id === id); if (m) m.creditsPer10k = amount(value); break; }
    case 'fscans': if (f) f.settings.byFrequency[id] = { ...f.settings.byFrequency[id], scans: wholeNumber(value) }; break;
    case 'fmodel': if (f) f.settings.byFrequency[id] = { ...f.settings.byFrequency[id], model: value || null }; break;
    case 'pscans': { const p = project(id); if (p) p.scansOverride = wholeNumber(value); break; }
    case 'pmodel': { const p = project(id); if (p) p.modelOverride = value || null; break; }
    default: return inputs;
  }
  return next;
}

function start() {
  const holder = document.getElementById('cx-live');
  const main = document.querySelector('main');
  if (!holder || !main) return;
  // Kept to write into "my version": this script as it is, and the hash the policy allows it by.
  const runtime = { text: document.currentScript?.textContent ?? '', hash: (document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content.match(/'sha256-[^']+'/) ?? [''])[0] };
  const state = JSON.parse(holder.textContent);
  const t = (text) => state.words?.[text] ?? text;
  const view = { t, lang: state.lang, dir: state.dir, look: state.look ?? undefined };
  let inputs = state.inputs;
  const live = () => ({ inputs, sentInputs: state.sentInputs, sentTotal: state.sentTotal, base: state.base, words: state.words, runtime });

  /** The body again: the levers' panel stays as it is (a slider being moved keeps moving), its figures follow. */
  const render = ({ panel = false } = {}) => {
    const focused = document.activeElement?.dataset?.lever;
    const tpl = document.createElement('template');
    tpl.innerHTML = reportMain(leverData(state.base, inputs), { ...view, live: live() });
    const fresh = tpl.content.querySelector('.levers');
    const old = main.querySelector('.levers');
    if (!panel && old && fresh) {
      for (const out of fresh.querySelectorAll('[data-out]')) {
        const mine = old.querySelector(`[data-out="${out.dataset.out}"]`);
        if (mine) mine.textContent = out.textContent;
      }
      old.querySelector('[data-act="reset"]').disabled = fresh.querySelector('[data-act="reset"]').disabled;
      fresh.replaceWith(old);
    }
    main.replaceChildren(tpl.content);
    if (focused) main.querySelector(`[data-lever="${CSS.escape(focused)}"]`)?.focus();
  };

  let queued = null;
  const moved = (event) => {
    const el = event.target.closest('[data-lever]');
    if (!el) return;
    // Boxes in the Fusion tables are written again with the body: they apply when left, not at each key.
    if (event.type === 'input' && el.type !== 'range' && !el.closest('.levers')) return;
    inputs = applyLever(inputs, el.dataset.lever, el.value, el.checked);
    const panel = el.dataset.lever === 'months';
    cancelAnimationFrame(queued);
    queued = requestAnimationFrame(() => render({ panel }));
  };
  // The small total at the bottom shows only while the panel with the total is out of sight.
  if ('IntersectionObserver' in window) {
    const seen = new IntersectionObserver(([entry]) => document.body.classList.toggle('lv-panel-seen', entry.isIntersecting));
    const watch = () => {
      seen.disconnect();
      const panel = main.querySelector('.levers .lv-total');
      if (panel) seen.observe(panel);
    };
    watch();
    new MutationObserver(watch).observe(main, { childList: true });
  }
  main.addEventListener('input', moved);
  main.addEventListener('change', moved);
  main.addEventListener('click', (event) => {
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (act === 'reset') {
      inputs = clone(state.sentInputs);
      render({ panel: true });
    } else if (act === 'pdf') {
      // The calculator's own PDF summary, of the report as it now stands.
      const button = event.target.closest('[data-act]');
      button.disabled = true;
      const data = leverData(state.base, inputs);
      slidesPdf(data, { ...view, calculations: Boolean(main.querySelector('[data-pdf-calculations]')?.checked) })
        .then((pdf) => save(pdf, slidesFileName(data.customer, new Date())))
        .finally(() => { button.disabled = false; });
    } else if (act === 'download') {
      const data = leverData(state.base, inputs);
      const html = buildReport(data, { ...view, live: live() });
      save(new Blob([html], { type: 'text/html' }), reportFileName(data.customer, new Date()).replace(/\.html$/, '_my-version.html'));
    }
  });
  const save = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
}

if (typeof document !== 'undefined') start();
