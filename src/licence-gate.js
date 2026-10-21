/**
 * The product licence in the standalone Cx Credits Calculator (src/standalone-calculator.js), which runs in a
 * browser with no server: the same end date and the same activation codes as the app (src/activation.js),
 * checked in the page with the browser's own cryptography. After the end date, unless a product code in date
 * has been entered, the page shows that it has been deactivated, with a field for the code; customers and
 * reports kept in the browser are left as they are.
 */
import { DEACTIVATED_MESSAGE, ISSUER_KEYS, PRODUCT_DEADLINE } from './activation.js';

/**
 * Check a product activation code with WebCrypto (`subtle`): signed by one of `keys` (base64 SPKI, Ed25519),
 * scope "product", action "activate". Returns its end date (ms) or 0. Self-contained: its source is put in the
 * page as it is, so the tests check the very code the page runs.
 */
export async function productCodeUntil(code, keys, subtle) {
  try {
    const parts = String(code || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'MZ1') return 0;
    const bytes = (b64url) => {
      const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    };
    const payload = JSON.parse(new TextDecoder().decode(bytes(parts[1])));
    const until = Date.parse(payload.expires);
    if (payload.v !== 1 || payload.scope !== 'product' || payload.action !== 'activate' || !payload.id || !payload.org || !Number.isFinite(until)) return 0;
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    for (const key of keys) {
      try {
        const pub = await subtle.importKey('spki', bytes(key), { name: 'Ed25519' }, false, ['verify']);
        if (await subtle.verify({ name: 'Ed25519' }, pub, bytes(parts[2]), signed)) return until;
      } catch {}
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * The gate's script, for a classic <script> before the calculator's module: it decides, and only then lets the
 * calculator start (window.__mzStart, which the module sets and calls itself when nothing holds it back).
 */
export function licenceGateScript({ keys = ISSUER_KEYS, deadline = PRODUCT_DEADLINE, message = DEACTIVATED_MESSAGE } = {}) {
  return `(() => {
  const DEADLINE = ${JSON.stringify(Date.parse(deadline))};
  const KEYS = ${JSON.stringify(keys)};
  const MESSAGE = ${JSON.stringify(message)};
  const CODE_KEY = 'mz-product-code';
  const SEEN_KEY = 'mz-licence-seen';
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  ${productCodeUntil.toString()}
  // Never earlier than the latest time this browser has seen: a clock set back does not undo the end date.
  const seen = Number(store.get(SEEN_KEY)) || 0;
  const now = Math.max(Date.now(), seen);
  if (Date.now() > seen) store.set(SEEN_KEY, String(Date.now()));
  if (now < DEADLINE) return;
  window.__mzBlocked = true;
  const start = () => {
    window.__mzBlocked = false;
    document.getElementById('mz-deactivated')?.remove();
    if (window.__mzStart) window.__mzStart();
  };
  const show = () => {
    if (document.getElementById('mz-deactivated')) return;
    const box = document.createElement('div');
    box.id = 'mz-deactivated';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', 'mz-deactivated-title');
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px 16px;background:var(--bg,#f5f6f8);color:var(--text,#14171c);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:auto';
    const [first, ...rest] = MESSAGE.split('. ');
    box.innerHTML = '<div style="width:min(520px,100%);background:var(--surface,#fff);border:1px solid var(--border,#e2e5e9);border-radius:16px;padding:28px 26px">'
      + '<h1 id="mz-deactivated-title" style="margin:0 0 8px;font-size:22px"></h1><p id="mz-deactivated-next" style="margin:0 0 14px"></p>'
      + '<p style="margin:0 0 14px;color:var(--muted,#5c636e);font-size:13.5px">Customers and reports kept in this browser are not deleted.</p>'
      + '<details><summary style="cursor:pointer;font-weight:600">Enter an activation code</summary>'
      + '<form id="mz-code-form" autocomplete="off"><textarea id="mz-code" spellcheck="false" placeholder="MZ1.…" style="width:100%;min-height:96px;margin-top:10px;padding:10px 12px;border:1px solid var(--border,#e2e5e9);border-radius:10px;font:12.5px/1.45 ui-monospace,Menlo,Consolas,monospace;word-break:break-all"></textarea>'
      + '<button type="submit" style="margin-top:10px;min-height:38px;padding:0 16px;border:0;border-radius:10px;background:var(--accent,#2856c9);color:var(--accent-ink,#fff);font-weight:600;cursor:pointer">Activate</button>'
      + '<p id="mz-code-status" role="status" style="min-height:20px;margin:10px 0 0;font-size:13.5px"></p></form></details></div>';
    box.querySelector('#mz-deactivated-title').textContent = first.endsWith('.') ? first : first + '.';
    box.querySelector('#mz-deactivated-next').textContent = rest.join('. ');
    box.querySelector('#mz-code-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = box.querySelector('#mz-code-status');
      const code = box.querySelector('#mz-code').value.trim();
      if (!(globalThis.crypto && crypto.subtle)) { status.textContent = 'This browser cannot check activation codes: open the file in a current Chrome, Edge, Firefox or Safari.'; return; }
      const until = await productCodeUntil(code, KEYS, crypto.subtle);
      if (until > now) { store.set(CODE_KEY, code); status.textContent = 'Activated until ' + new Date(until).toISOString().slice(0, 10) + '.'; setTimeout(start, 600); }
      else status.textContent = until ? 'This activation code has expired.' : 'This activation code is not valid.';
    });
    (document.body || document.documentElement).appendChild(box);
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  // A code entered before, still in date, opens it again.
  const kept = store.get(CODE_KEY);
  if (kept && globalThis.crypto && crypto.subtle) productCodeUntil(kept, KEYS, crypto.subtle).then((until) => { if (until > now) start(); });
})();`;
}
