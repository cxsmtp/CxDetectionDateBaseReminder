// Currencies: every ISO 4217 code this runtime knows (the same list the browser offers), and
// amounts written the way that currency is written ("₹1,23,457", "¥1,235", "€1,234.50").

let known = null;
/** Every current currency code ("AED" … "ZWL"). */
export function currencies() {
  if (!known) {
    try {
      known = new Set(Intl.supportedValuesOf('currency'));
    } catch {
      known = new Set();
    }
  }
  return known;
}

/** `code` in capitals when it is a currency this runtime knows; '' otherwise. */
export function validCurrency(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return '';
  return currencies().size === 0 || currencies().has(c) ? c : '';
}

/** An amount in `currency`, at most `digits` decimals ("—" for none). */
export function formatMoney(n, currency, { digits = 0, locale = 'en-US' } = {}) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: digits }).format(Number(n));
  } catch {
    return `${Number(n).toLocaleString(locale, { maximumFractionDigits: digits })} ${currency}`;
  }
}
