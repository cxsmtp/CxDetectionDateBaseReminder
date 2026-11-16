// What a person sets for themselves, and the organisation's look it sits over: theme, look, accent and scan
// colours, the app's name, logo and icon, a person's own branding, language, profile and own two-step sign-in.
import { LANGUAGES, availableLanguages, currentLanguage, deviceTimeZone, onLanguageChange, setAvailable, setLanguage, setTimeZone, startI18n, t } from '../i18n.js';
import { $, can, state } from './state.js';
import { escapeHtml } from './format.js';
import { api, handleAuthLoss, setStatus, showError } from './core.js';
import { showRecoveryCodes, showTwoStepKey } from './session.js';
import { loadAccess } from './access.js';

// ---- Settings → Your branding: one's own names, logo and colours, for demonstrations ----

const MB_FIELDS = [['mb-app', 'appName'], ['mb-name', 'companyName'], ['mb-logo', 'logoUrl'], ['mb-height', 'logoHeight'], ['mb-cta', 'callToAction']];
const myBrand = { org: null, timer: null };

/** The header's name and logo: the organisation's, with this person's own over it while they use it. */
export function applyMyAppBranding() {
  const b = state.me?.branding;
  if (b) applyAppBranding({ name: b.appName, logoUrl: b.logoUrl });
}

export async function refreshMyAppBranding() {
  try {
    state.me = await api('/api/me', { quiet: true });
    applyMyAppBranding();
  } catch {}
}

export async function loadMyBranding() {
  if (!can('branding.personal')) return;
  try {
    renderMyBranding(await api('/api/me/branding', { quiet: true }));
  } catch (error) {
    if (!handleAuthLoss(error)) showError('mb-status', error);
  }
}

function renderMyBranding({ branding: b, organisation: o }) {
  myBrand.org = o;
  $('mb-on').checked = b.on;
  for (const [id, key] of MB_FIELDS) {
    if (document.activeElement !== $(id)) $(id).value = b[key] || '';
    const org = o[key];
    $(id).placeholder = key === 'logoUrl' && String(org).startsWith('data:') ? 'The organisation’s uploaded logo' : String(org || '');
  }
  const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c ?? '') ? c : '#1d4ed8');
  $('mb-accent').value = hex(b.accentColor || o.accentColor);
  $('mb-accent').dataset.org = b.accentColor ? '' : '1';
  $('mb-accent-org').hidden = !b.accentColor;
  renderMyBrandPreview();
}

function myBrandingPayload() {
  return {
    on: $('mb-on').checked,
    ...Object.fromEntries(MB_FIELDS.map(([id, key]) => [key, key === 'logoHeight' ? Number($(id).value) || 0 : $(id).value])),
    accentColor: $('mb-accent').dataset.org === '1' ? '' : $('mb-accent').value,
  };
}

/** The head of a reminder or report as it will look: the organisation's, with yours over it. */
function renderMyBrandPreview() {
  const o = myBrand.org ?? {};
  const p = myBrandingPayload();
  const pick = (key) => p[key] || o[key];
  const url = pick('logoUrl');
  const name = pick('companyName');
  const box = $('mb-preview');
  const head = url && /^(https:\/\/|data:image\/)/i.test(url)
    ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(name || '')}" style="height:${Number(pick('logoHeight')) || 40}px;max-width:260px;display:block" />`
    : name
      ? `<strong style="font-size:17px" translate="no">${escapeHtml(name)}</strong>`
      : '<span class="hint">No logo or company name: a plain header.</span>';
  box.innerHTML = `<p class="hint">${p.on ? 'What you send now:' : 'What you would send with it on:'} <b translate="no">${escapeHtml(pick('appName') || 'CxMissionZero')}</b></p>
    <div style="border-bottom:2px solid ${escapeHtml(p.accentColor || o.accentColor || '#1d4ed8')};padding-bottom:10px">${head}</div>
    ${pick('callToAction') ? `<p style="margin:10px 0 0" translate="no">${escapeHtml(pick('callToAction'))}</p>` : ''}`;
}

async function saveMyBranding() {
  clearTimeout(myBrand.timer);
  setStatus('mb-status', 'Saving…');
  try {
    const result = await api('/api/me/branding', { method: 'PUT', body: JSON.stringify(myBrandingPayload()), quiet: true });
    state.me = result.me;
    applyMyAppBranding();
    renderMyBranding(result);
    setStatus('mb-status', result.branding.on ? 'Saved. What you send now carries your branding.' : 'Saved. You use the organisation’s branding.', 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('mb-status', error);
  }
}

export function wireMyBranding() {
  $('set-mybrand').addEventListener('input', (event) => {
    if (event.target.id === 'mb-logo-file' || event.target.id === 'mb-on') return;
    if (event.target.id === 'mb-accent') {
      $('mb-accent').dataset.org = '';
      $('mb-accent-org').hidden = false;
    }
    // Typing your own name, logo or colour means using them: the switch turns on with it (off again is one click).
    if (!$('mb-on').checked && String(event.target.value ?? '').trim()) $('mb-on').checked = true;
    renderMyBrandPreview();
    clearTimeout(myBrand.timer);
    myBrand.timer = setTimeout(saveMyBranding, 700);
  });
  $('mb-on').addEventListener('change', saveMyBranding);
  $('mb-accent-org').addEventListener('click', () => {
    $('mb-accent').dataset.org = '1';
    saveMyBranding();
  });
  $('mb-clear').addEventListener('click', () => {
    if (!confirm('Clear your branding? You go back to the organisation’s.')) return;
    for (const [id] of MB_FIELDS) $(id).value = '';
    $('mb-accent').dataset.org = '1';
    $('mb-on').checked = false;
    saveMyBranding();
  });
  $('mb-logo-file').addEventListener('change', () => {
    const file = $('mb-logo-file').files[0];
    $('mb-logo-file').value = '';
    if (!file) return;
    if (file.size > 200 * 1024) return alert('That image is larger than 200 KB. Please use a smaller logo.');
    const reader = new FileReader();
    reader.onload = () => {
      $('mb-logo').value = reader.result;
      $('mb-logo').dispatchEvent(new Event('input', { bubbles: true }));
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Theme: follow the device, or light / dark as chosen (kept in this browser)
// ---------------------------------------------------------------------------

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABELS = { auto: 'Theme: follow the device', light: 'Theme: light', dark: 'Theme: dark' };

function applyTheme(theme, { save = false } = {}) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  $('theme-toggle').title = THEME_LABELS[theme] ?? THEME_LABELS.auto;
  try {
    if (theme === 'auto') localStorage.removeItem('mz-theme');
    else localStorage.setItem('mz-theme', theme);
  } catch {}
  syncLookMenu();
  // Chosen here: kept on their profile too, so every computer they use shows it.
  if (save && state.me?.user) saveProfile({ theme: THEMES.includes(theme) ? theme : 'auto' }, { silent: true });
}

// ---------------------------------------------------------------------------
// Look: Signal, Command center, Studio, Atelier or Classic (public/look.js), and the accent. The
// organisation's look is an Admin's (Settings → Branding), as is whether people may pick their own; a
// person's own is kept on their profile and in this browser (index.html applies it before first paint).
// ---------------------------------------------------------------------------

const LOOK_ACCENTS = ['indigo', 'cyan', 'emerald', 'violet', 'amber'];
export const LOOKS = ['cabin', 'circuit', 'residence', 'chronometer', 'signal', 'nextgen', 'studio', 'atelier', 'classic'];
const LOOK_NAMES = { cabin: 'Cabin', circuit: 'Circuit', residence: 'Residence', chronometer: 'Chronometer', signal: 'Signal', nextgen: 'Command center', studio: 'Studio', atelier: 'Atelier', classic: 'Classic' };
// The accent tints the looks made for it: Signal's signal colour, Command center's and Atelier's ink.
const ACCENT_LOOKS = new Set(['cabin', 'circuit', 'signal', 'nextgen', 'atelier']);
const stored = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const look = {
  org: LOOKS.includes(stored('mz-org-look')) ? stored('mz-org-look') : stored('mz-nextgen-off') === '1' ? 'classic' : 'nextgen',
  choice: stored('mz-look-choice') !== '0',
  own: LOOKS.includes(stored('mz-look')) ? stored('mz-look') : '',
};
// Cabin, Circuit, Residence and Chronometer are drawn on Signal's open pages: html[data-look="signal cabin"].
const LOOK_ATTR = { cabin: 'signal cabin', circuit: 'signal circuit', residence: 'signal residence', chronometer: 'signal chronometer' };
const currentLook = () => {
  if (document.documentElement.dataset.ui !== 'nextgen') return 'classic';
  const attr = (document.documentElement.dataset.look ?? '').split(' ');
  return LOOKS.find((l) => l !== 'nextgen' && attr.at(-1) === l) ?? 'nextgen';
};
const currentAccent = () => document.documentElement.dataset.accent || 'indigo';
const remember = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
};

function syncLookMenu() {
  const menu = document.getElementById('look-menu');
  if (!menu) return;
  // The look's own gold and pink change with the look and theme.
  if (typeof syncScanColours === 'function') queueMicrotask(() => syncScanColours());
  for (const box of menu.querySelectorAll('input[name="look"]')) box.checked = box.value === look.own;
  for (const box of menu.querySelectorAll('input[name="look-theme"]')) box.checked = box.value === (document.documentElement.dataset.theme || 'auto');
  for (const box of menu.querySelectorAll('input[name="look-accent"]')) box.checked = box.value === currentAccent();
  $('look-org-name').textContent = LOOK_NAMES[look.org];
  menu.querySelector('.look-card-org .look-mini').dataset.mini = look.org;
  $('look-pick').hidden = !look.choice;
  $('look-accent').hidden = !ACCENT_LOOKS.has(currentLook());
}

/** Show a look: the person's own when the organisation lets people choose, else the organisation's. */
function showLook() {
  const value = look.choice && look.own ? look.own : look.org;
  if (value === 'classic') delete document.documentElement.dataset.ui;
  else document.documentElement.dataset.ui = 'nextgen';
  if (value === 'classic' || value === 'nextgen') delete document.documentElement.dataset.look;
  else document.documentElement.dataset.look = LOOK_ATTR[value] ?? value;
  syncLookMenu();
}

/** This person's own look ('' is the organisation's). */
function applyLook(choice, { save = false } = {}) {
  look.own = LOOKS.includes(choice) ? choice : '';
  remember('mz-look', look.own || null);
  showLook();
  if (save && state.me?.user) saveProfile({ look: look.own }, { silent: true });
}

function applyAccent(accent, { save = false } = {}) {
  const value = LOOK_ACCENTS.includes(accent) ? accent : 'indigo';
  if (value === 'indigo') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = value;
  remember('mz-accent', value === 'indigo' ? null : value);
  syncLookMenu();
  if (save && state.me?.user) saveProfile({ accent: value }, { silent: true });
}

/** The organisation's choices (from /api/health or Settings → Branding): its look, people's own or not, and where the menu sits. */
export function applyOrgLook({ look: orgLook, lookChoice, nextGen, navPosition } = {}) {
  // A server from before there were looks to choose sends only nextGen.
  look.org = LOOKS.includes(orgLook) ? orgLook : nextGen === false ? 'classic' : 'nextgen';
  look.choice = orgLook ? lookChoice !== false : nextGen !== false;
  remember('mz-org-look', look.org);
  remember('mz-look-choice', look.choice ? null : '0');
  remember('mz-nextgen-off', null);
  showLook();
  if (navPosition === 'top') document.documentElement.dataset.nav = 'top';
  else delete document.documentElement.dataset.nav;
  remember('mz-nav', navPosition === 'top' ? 'top' : null);
}

/** Signed in: the look, theme and accent on their profile, when they chose one. */
export function applyProfileLook(profile = {}) {
  if ('look' in profile && (profile.look || '') !== look.own) applyLook(profile.look);
  if (profile.theme && profile.theme !== (document.documentElement.dataset.theme || 'auto')) applyTheme(profile.theme);
  if (profile.accent) applyAccent(profile.accent);
  if (profile.scanColours) applyScanColours(profile.scanColours);
}

// ---- Fusion and LAST colours: the look's gold and pink, or the person's own (Settings → Your appearance).
const HEX = /^#[0-9a-f]{6}$/i;
const scanColours = { fusion: '', last: '' };
/** A colour in OKLab, to tell how far apart two look (×100, as ΔE). */
function oklab(hex) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const colourGap = (a, b) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i])) * 100;
/** The colours shown now: the person's own, else what the look sets (read from the page's own styles). */
function lookScanColours() {
  const root = document.documentElement;
  const own = { fusion: root.style.getPropertyValue('--scan-fusion'), last: root.style.getPropertyValue('--scan-last') };
  root.style.removeProperty('--scan-fusion');
  root.style.removeProperty('--scan-last');
  const css = getComputedStyle(root);
  const out = { fusion: css.getPropertyValue('--scan-fusion').trim(), last: css.getPropertyValue('--scan-last').trim() };
  if (own.fusion) root.style.setProperty('--scan-fusion', own.fusion);
  if (own.last) root.style.setProperty('--scan-last', own.last);
  return out;
}
function syncScanColours() {
  const box = $('scan-colours');
  if (!box) return;
  const looks = lookScanColours();
  document.documentElement.style.setProperty('--scan-fusion-look', looks.fusion);
  document.documentElement.style.setProperty('--scan-last-look', looks.last);
  for (const kind of ['fusion', 'last']) {
    const value = scanColours[kind];
    let matched = false;
    for (const radio of box.querySelectorAll(`input[name="scan-${kind}"]`)) {
      radio.checked = radio.value === value;
      matched ||= radio.checked;
    }
    $(`scan-${kind}-custom`).value = HEX.test(value) ? value : HEX.test(looks[kind]) ? looks[kind] : '#888888';
    $(`scan-${kind}-custom`).closest('.scan-sw-custom').classList.toggle('is-on', !matched);
  }
  // Too close to tell apart, or to a severity's colour: said, and the tags stay on every row anyway.
  const shown = { fusion: scanColours.fusion || looks.fusion, last: scanColours.last || looks.last };
  const notes = [];
  if (HEX.test(shown.fusion) && HEX.test(shown.last) && colourGap(shown.fusion, shown.last) < 15) notes.push('Fusion and LAST are hard to tell apart in these colours.');
  for (const [kind, colour] of Object.entries(shown)) {
    if (!HEX.test(colour)) continue;
    const near = Object.entries({ critical: '#dc2626', high: '#ea580c' }).find(([, sev]) => colourGap(colour, sev) < 8);
    if (near) notes.push(`${kind === 'fusion' ? 'Fusion' : 'LAST'} is close to the ${near[0]} severity colour.`);
  }
  // Each sentence on its own, so each is translated as it is.
  $('scan-colour-note').hidden = !notes.length;
  $('scan-colour-note').innerHTML = notes.length ? [...notes, 'The Fusion and LAST tags stay on every row.'].map((n) => `<span>${escapeHtml(n)}</span>`).join(' ') : '';
}
function applyScanColours(value = {}, { save = false } = {}) {
  for (const kind of ['fusion', 'last']) {
    scanColours[kind] = HEX.test(value[kind] ?? '') ? value[kind].toLowerCase() : '';
    if (scanColours[kind]) document.documentElement.style.setProperty(`--scan-${kind}`, scanColours[kind]);
    else document.documentElement.style.removeProperty(`--scan-${kind}`);
  }
  remember('mz-scan-colours', scanColours.fusion || scanColours.last ? JSON.stringify(scanColours) : null);
  syncScanColours();
  if (save && state.me?.user) saveProfile({ scanColours: { ...scanColours } }, { silent: true });
}

export function wireThemeAndLook() {
  $('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'auto';
    applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length], { save: true });
  });
  try {
    const kept = JSON.parse(localStorage.getItem('mz-scan-colours') ?? 'null');
    if (kept) for (const k of ['fusion', 'last']) scanColours[k] = HEX.test(kept[k] ?? '') ? kept[k] : '';
  } catch {}
  applyScanColours(scanColours);
  $('scan-colours')?.addEventListener('change', (event) => {
    const box = event.target;
    const kind = box.name === 'scan-fusion' || box.id === 'scan-fusion-custom' ? 'fusion' : box.name === 'scan-last' || box.id === 'scan-last-custom' ? 'last' : '';
    if (kind) applyScanColours({ ...scanColours, [kind]: box.value }, { save: true });
  });
  $('scan-colours-reset')?.addEventListener('click', () => applyScanColours({}, { save: true }));

  // Settings → Your appearance (the light/dark switch stays in the top bar, for a quick change).
  $('look-menu').addEventListener('change', (event) => {
    const box = event.target;
    if (box.name === 'look') applyLook(box.value, { save: true });
    else if (box.name === 'look-theme') applyTheme(box.value, { save: true });
    else if (box.name === 'look-accent') applyAccent(box.value, { save: true });
  });
  syncLookMenu();
  $('theme-toggle').title = THEME_LABELS[document.documentElement.dataset.theme || 'auto'];
}

/** The app's own name and logo, in the header and the browser tab. */
/** Changes whenever the icon setting does (no need to match the server's fingerprint: it only busts the cache). */
export const iconKey = (url = '') => (url ? `${url.length}${url.slice(-16).replace(/[^\w]/g, '')}` : '');

/** The tab's icon: reloaded when it changes (the server serves the one set in Branding, else CxMissionZero's own). */
export function applyAppIcon(version = '') {
  const link = document.getElementById('app-icon');
  if (link && link.dataset.version !== String(version)) {
    link.dataset.version = String(version);
    link.href = `/app-icon${version ? `?v=${encodeURIComponent(version)}` : ''}`;
  }
}

/** Settings → Branding: what the icon will look like, as typed or uploaded (empty: CxMissionZero's own). */
export function renderIconPreview() {
  const value = $('brand-icon').value.trim();
  $('brand-icon-preview').src = value && (/^data:image\//i.test(value) || /^https:\/\//i.test(value)) ? value : '/mz-icon-64.png';
}

export function applyAppBranding({ name, logoUrl, iconVersion, look: orgLook, lookChoice, nextGen, navPosition } = {}) {
  if (iconVersion !== undefined) applyAppIcon(iconVersion);
  if (nextGen !== undefined || orgLook !== undefined) applyOrgLook({ look: orgLook, lookChoice, nextGen, navPosition });
  const appName = name || 'CxMissionZero';
  $('app-name').textContent = appName;
  document.title = appName;
  const logo = $('app-logo');
  logo.hidden = !logoUrl;
  if (logoUrl) {
    logo.src = logoUrl;
    logo.alt = `${appName} logo`;
  }
}

export function wireAppBranding() {
  $('brand-icon').addEventListener('input', renderIconPreview);
  $('brand-icon-default').addEventListener('click', () => {
    $('brand-icon').value = '';
    $('brand-icon').dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('brand-icon-file').addEventListener('change', () => {
    const file = $('brand-icon-file').files[0];
    $('brand-icon-file').value = '';
    if (!file) return;
    if (file.size > 100 * 1024) return alert('That image is larger than 100 KB. Please use a smaller icon.');
    const reader = new FileReader();
    reader.onload = () => {
      $('brand-icon').value = reader.result;
      $('brand-icon').dispatchEvent(new Event('input', { bubbles: true }));
    };
    reader.readAsDataURL(file);
  });

  $('brand-logo-file').addEventListener('change', () => {
    const file = $('brand-logo-file').files[0];
    if (!file) return;
    if (file.size > 200 * 1024) {
      alert('That image is larger than 200 KB. Please use a smaller logo.');
      $('brand-logo-file').value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      $('brand-logo').value = reader.result;
      $('brand-logo').dispatchEvent(new Event('input', { bubbles: true }));
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Language: the page's own words in the reader's language (public/i18n.js).
// ---------------------------------------------------------------------------

/** Set once the language picker exists: offer the languages this server has unlocked. */
export let languagesChanged = () => {};

// ---------------------------------------------------------------------------
// Your profile (Settings › Your profile, also under your name at the top right): name, picture,
// language, time zone and programming languages. Stored with your account, so it follows you.
// ---------------------------------------------------------------------------

/** A person's picture in `el`, else the first letter of their name. */
export function showAvatar(el, user) {
  if (user?.avatarAt) {
    el.innerHTML = `<img src="/api/users/${encodeURIComponent(user.id)}/avatar?v=${encodeURIComponent(user.avatarAt)}" alt="" />`;
  } else {
    el.textContent = (user?.name || user?.email || '?').trim()[0]?.toUpperCase() ?? '?';
  }
}

const profileZone = (profile) => (profile?.timeZoneAuto === false && profile.timeZone ? profile.timeZone : deviceTimeZone());

/** After signing in: the account's language and time zone; a new computer's zone is noted quietly. */
export function applyProfile(me) {
  const profile = me.user.profile ?? {};
  setTimeZone(profileZone(profile));
  if (profile.language && profile.language !== currentLanguage()) setLanguage(profile.language);
  const quiet = {};
  if (!profile.language && currentLanguage() !== 'en') quiet.language = currentLanguage();
  if (profile.timeZoneAuto !== false && deviceTimeZone() && profile.timeZone !== deviceTimeZone()) quiet.timeZone = deviceTimeZone();
  if (Object.keys(quiet).length) saveProfile({ ...quiet, quiet: true }, { silent: true });
}

/**
 * Someone else's profile, opened by an Admin from People & roles ({user, languages}), or null:
 * then the panel is the signed-in person's own. Never their own through this.
 */
let profileOf = null;

export async function openProfileOf(id) {
  try {
    profileOf = await api(`/api/iam/users/${encodeURIComponent(id)}/profile`);
    location.hash = '#/settings/profile';
    renderProfile();
    setStatus('pf-status', '');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-status', error);
  }
}

export function closeProfileOf() {
  if (!profileOf) return;
  profileOf = null;
  renderProfile();
  setStatus('pf-status', '');
}

let profileSaving = Promise.resolve();
/** Save part of the profile (one request at a time, in order): one's own, or, for an Admin, the person opened. */
function saveProfile(patch, { silent = false } = {}) {
  if (profileOf) {
    const id = profileOf.user.id;
    profileSaving = profileSaving.then(async () => {
      try {
        const saved = await api(`/api/iam/users/${encodeURIComponent(id)}/profile`, { method: 'PUT', body: JSON.stringify(patch) });
        if (profileOf?.user.id !== id) return;
        profileOf = { ...profileOf, user: saved.user };
        renderProfile();
        setStatus('pf-status', 'Saved.', 'ok');
      } catch (error) {
        if (!handleAuthLoss(error)) showError('pf-status', error);
        if (profileOf?.user.id === id) renderProfile();
      }
    });
    return profileSaving;
  }
  profileSaving = profileSaving.then(async () => {
    try {
      const me = await api('/api/me/profile', { method: 'PUT', body: JSON.stringify(patch), quiet: silent });
      state.me = { ...state.me, user: me.user };
      $('me-name').textContent = me.user.name || me.user.email;
      setTimeZone(profileZone(me.user.profile));
      if (!silent) {
        setStatus('pf-status', 'Saved.', 'ok');
        if (state.page === 'settings') renderProfile();
      }
    } catch (error) {
      if (!handleAuthLoss(error) && !silent) showError('pf-status', error);
    }
  });
  return profileSaving;
}

const PROGRAMMING = ['Apex', 'C', 'C++', 'C#', 'COBOL', 'Dart', 'Go', 'Groovy', 'Java', 'JavaScript', 'Kotlin', 'Objective-C', 'Perl', 'PHP', 'PL/SQL', 'Python', 'Ruby', 'Rust', 'Scala', 'Swift', 'TypeScript', 'VB.NET', 'Infrastructure as code'];

// Currencies: every one the browser knows (the server checks against the same list), named in
// the page's language, and amounts written the way that currency is written ("₹1,23,457").
function currencyCodes() {
  try {
    return Intl.supportedValuesOf('currency');
  } catch {
    return ['AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'HKD', 'IDR', 'ILS', 'INR', 'JPY', 'KRW', 'MYR', 'SAR', 'SGD', 'THB', 'TWD', 'USD', 'VND', 'AED'];
  }
}

function currencyName(code) {
  try {
    return new Intl.DisplayNames([currentLanguage(), 'en'], { type: 'currency' }).of(code) || code;
  } catch {
    return code;
  }
}

/** The select's options: every currency as "INR · Indian Rupee" (`first`: an empty choice on top). */
export function fillCurrencies(select, value, { first = '' } = {}) {
  const codes = currencyCodes();
  const list = value && !codes.includes(value) ? [value, ...codes] : codes;
  select.innerHTML = (first ? `<option value="">${escapeHtml(first)}</option>` : '')
    + list.map((code) => `<option value="${escapeHtml(code)}" translate="no">${escapeHtml(code)} · ${escapeHtml(currencyName(code))}</option>`).join('');
  select.value = value;
}

export function moneyOf(n, currency, digits) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: digits }).format(Number(n));
  } catch {
    return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: digits })} ${currency}`;
  }
}

/** The figures in Your profile → Your Impact figures, as the page holds them (empty: the organisation's). */
function personalImpact() {
  const out = { currency: $('pf-currency').value };
  for (const input of document.querySelectorAll('#pf-impact [data-pi]')) out[input.dataset.pi] = input.value.trim() === '' ? null : Number(input.value);
  return out;
}

/** Your profile → Your Impact figures: yours where given, the organisation's in grey where not. */
function renderPersonalImpact(profile) {
  const org = state.me?.organisationImpact ?? {};
  const mine = profile.impact ?? {};
  const select = $('pf-currency');
  if (document.activeElement !== select) fillCurrencies(select, mine.currency || '', { first: "The organisation's currency" });
  const own = Boolean(mine.currency) && mine.currency !== org.currency;
  for (const input of document.querySelectorAll('#pf-impact [data-pi]')) {
    const key = input.dataset.pi;
    // In a currency of their own, the organisation's money figures (in another currency) do not apply.
    const money = key === 'hourlyRate' || key === 'creditPrice';
    input.placeholder = money && own ? '0' : String(org[key] ?? '');
    if (document.activeElement !== input) input.value = mine[key] ?? '';
  }
  $('pf-impact-hint').innerHTML = own
    ? `<span>In a currency of your own, give your own hourly cost and price of one credit. The organisation's are in:</span> <b translate="no">${escapeHtml(org.currency || 'USD')}</b>`
    : `<span>The organisation's currency:</span> <b translate="no">${escapeHtml(org.currency || 'USD')}</b>`;
}

// ---- Your profile → Two-step sign-in: on, off, and new recovery codes, each with a code from the app ----

/** What the code form is for right now: 'enable' (with the key shown), 'disable' or 'codes'; '' when it is closed. */
let ownTwoStepStep = '';

function renderOwnTwoStep() {
  const mine = state.me?.twoStep;
  // Only one's own, and only for people who have a password to protect.
  const shown = !profileOf && Boolean(mine?.available);
  $('pf-twostep-block').hidden = !shown;
  if (!shown) return;
  const since = mine.since ? new Date(mine.since).toLocaleDateString() : '';
  $('pf-twostep-state').innerHTML = mine.on
    ? `<span class="badge">On</span> <span>Turned on:</span> <b translate="no">${escapeHtml(since)}</b> · <span>Recovery codes left:</span> <b translate="no">${Number(mine.recoveryLeft) || 0}</b>${mine.required ? ' · <span>An administrator requires it, so it cannot be turned off.</span>' : ''}`
    : `<span class="badge muted">Off</span>${mine.required ? ' <span>An administrator requires it for everyone who signs in with a password: turn it on now, or you are asked to at your next sign-in.</span>' : ''}`;
  const busy = Boolean(ownTwoStepStep) || !$('pf-twostep-recovery').hidden;
  $('pf-twostep-actions').hidden = busy;
  $('pf-twostep-on').hidden = mine.on;
  $('pf-twostep-codes').hidden = !mine.on;
  $('pf-twostep-off').hidden = !mine.on || mine.required;
  $('pf-twostep-setup').hidden = ownTwoStepStep !== 'enable';
  $('pf-twostep-form').hidden = !ownTwoStepStep;
  $('pf-twostep-ask').textContent =
    ownTwoStepStep === 'disable'
      ? 'To turn two-step sign-in off, enter a current code from your authenticator app.'
      : ownTwoStepStep === 'codes'
        ? 'To make new recovery codes, enter a current code from your authenticator app. The old recovery codes stop working.'
        : '';
  $('pf-twostep-ask').hidden = ownTwoStepStep === 'enable' || !ownTwoStepStep;
  $('pf-twostep-submit').textContent = ownTwoStepStep === 'enable' ? 'Turn on' : ownTwoStepStep === 'disable' ? 'Turn off' : 'Make new codes';
}

function openOwnTwoStep(step) {
  ownTwoStepStep = step;
  $('pf-twostep-code').value = '';
  renderOwnTwoStep();
  if (step) $('pf-twostep-code').focus();
}

/** "Asia/Tokyo (UTC+09:00)". */
function profileZoneLabel(zone) {
  try {
    const offset = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
    return `${zone.replace(/_/g, ' ')} (${offset.replace('GMT', 'UTC') || 'UTC'})`;
  } catch {
    return zone;
  }
}

export function renderProfile() {
  const me = state.me;
  if (!me) return;
  const other = Boolean(profileOf);
  const user = other ? profileOf.user : me.user;
  const profile = user.profile ?? {};
  $('pf-title').textContent = other ? "A person's profile" : 'Your profile';
  $('pf-intro').hidden = other;
  $('pf-other').hidden = !other;
  $('pf-email').hidden = other;
  $('pf-email-edit').hidden = !other;
  $('pf-via-row').hidden = other;
  $('pf-tz-device-line').hidden = other;
  $('pf-look-block').hidden = !other;
  $('pf-impact-title').textContent = other ? 'Their Impact figures' : 'Your Impact figures';
  showAvatar($('pf-avatar'), user);
  $('pf-avatar-remove').hidden = !user.avatarAt;
  $('pf-email').textContent = user.email;
  if (other && document.activeElement !== $('pf-email-input')) $('pf-email-input').value = user.email;
  $('pf-role').textContent = other ? user.roleName : me.role.name;
  $('pf-via').textContent = me.via === 'cxone' ? 'A Checkmarx One key' : me.via === 'sso' ? 'Single sign-on' : 'A password';
  $('pf-last').textContent = user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—';
  if (document.activeElement !== $('pf-name')) $('pf-name').value = user.name ?? '';
  const language = $('pf-language');
  const languages = other ? LANGUAGES.filter(([code]) => profileOf.languages.includes(code)) : availableLanguages();
  language.innerHTML = languages.map(([code, name]) => `<option value="${code}" lang="${code}">${escapeHtml(name)}</option>`).join('');
  language.value = profile.language || (other ? 'en' : currentLanguage());
  if (other) {
    $('pf-look').value = profile.look ?? '';
    $('pf-theme').value = profile.theme ?? 'auto';
    $('pf-accent').value = profile.accent ?? 'indigo';
  }
  renderOwnTwoStep();
  const zones = $('pf-tz');
  if (!zones.options.length) {
    let all = [];
    try {
      all = Intl.supportedValuesOf('timeZone');
    } catch {}
    const device = deviceTimeZone();
    if (device && !all.includes(device)) all.unshift(device);
    if (!all.includes('UTC')) all.push('UTC');
    zones.innerHTML = all.map((zone) => `<option value="${escapeHtml(zone)}">${escapeHtml(profileZoneLabel(zone))}</option>`).join('');
  }
  const auto = profile.timeZoneAuto !== false;
  $('pf-tz-auto').checked = auto;
  $('pf-tz-device').textContent = profileZoneLabel(deviceTimeZone() || 'UTC');
  zones.value = profileZone(profile) || 'UTC';
  zones.disabled = auto;
  const picked = new Set(profile.programmingLanguages ?? []);
  renderPersonalImpact(profile);
  $('pf-langs').innerHTML = PROGRAMMING.map((name) => `<label${name === 'Infrastructure as code' ? '' : ' translate="no"'}><input type="checkbox" value="${escapeHtml(name)}"${picked.has(name) ? ' checked' : ''} /> ${escapeHtml(name)}</label>`).join('');
}

export function wireLanguageAndProfile() {
  {
    const select = $('lang-select');
    const SHORT = { en: 'EN', ja: 'JA', 'zh-TW': '繁中', 'zh-CN': '简中', ko: 'KO', es: 'ES', 'pt-BR': 'PT', de: 'DE', fr: 'FR', ar: 'AR', vi: 'VI', th: 'TH', ms: 'MS', id: 'ID', he: 'HE' };
    const fill = () => {
      select.innerHTML = availableLanguages().map(([code, name]) => `<option value="${code}" lang="${code}">${escapeHtml(name)}</option>`).join('');
      select.value = currentLanguage();
    };
    fill();
    // Languages unlocked by an activation code (Hebrew) are offered once the server says so. Only
    // the signed-in answer (`final`) switches someone back to English: before it, the page may not
    // know yet that this person is one of those Hebrew is open to.
    languagesChanged = (codes, final = false) => {
      const allowed = setAvailable(codes);
      fill();
      if (!allowed && final) setLanguage('en');
    };
    const show = (code) => {
      select.value = code;
      select.setAttribute('aria-label', t('Language'));
      $('lang-code').textContent = SHORT[code] ?? code.toUpperCase();
    };
    onLanguageChange(show);
    select.addEventListener('change', async () => {
      await setLanguage(select.value);
      if (state.me) saveProfile({ language: select.value });
    });
    show(currentLanguage());
    startI18n();
  }

  {
    $('pf-twostep-on').addEventListener('click', async () => {
      setStatus('pf-twostep-status', '');
      try {
        const setup = await api('/api/me/two-step/setup', { method: 'POST' });
        showTwoStepKey($('pf-twostep-key'), setup);
        openOwnTwoStep('enable');
      } catch (error) {
        if (!handleAuthLoss(error)) showError('pf-twostep-status', error);
      }
    });
    $('pf-twostep-off').addEventListener('click', () => {
      setStatus('pf-twostep-status', '');
      openOwnTwoStep('disable');
    });
    $('pf-twostep-codes').addEventListener('click', () => {
      setStatus('pf-twostep-status', '');
      openOwnTwoStep('codes');
    });
    $('pf-twostep-cancel').addEventListener('click', () => {
      $('pf-twostep-key').textContent = '';
      setStatus('pf-twostep-status', '');
      openOwnTwoStep('');
    });
    $('pf-twostep-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const step = ownTwoStepStep;
      if (!step) return;
      const path = { enable: '/api/me/two-step/enable', disable: '/api/me/two-step/disable', codes: '/api/me/two-step/recovery-codes' }[step];
      const button = $('pf-twostep-submit');
      button.disabled = true;
      try {
        const answer = await api(path, { method: 'POST', body: JSON.stringify({ code: $('pf-twostep-code').value.trim() }) });
        state.me = { ...state.me, user: answer.me.user, twoStep: answer.me.twoStep };
        $('pf-twostep-key').textContent = '';
        ownTwoStepStep = '';
        if (answer.recoveryCodes) {
          showRecoveryCodes($('pf-recovery-codes'), answer.recoveryCodes);
          $('pf-twostep-recovery').hidden = false;
        }
        setStatus('pf-twostep-status', step === 'enable' ? 'Two-step sign-in is on.' : step === 'disable' ? 'Two-step sign-in is off.' : 'New recovery codes made. The old ones no longer work.', 'ok');
        renderOwnTwoStep();
      } catch (error) {
        $('pf-twostep-code').value = '';
        if (handleAuthLoss(error)) return;
        showError('pf-twostep-status', error);
        // The key was shown more than ten minutes ago: start again from the button.
        if (error.body?.restart) openOwnTwoStep('');
      } finally {
        button.disabled = false;
      }
    });
    $('pf-recovery-done').addEventListener('click', () => {
      $('pf-recovery-codes').textContent = '';
      $('pf-twostep-recovery').hidden = true;
      renderOwnTwoStep();
    });
  }

  {
    let nameTimer = null;
    $('pf-name').addEventListener('input', () => {
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => saveProfile({ name: $('pf-name').value }), 700);
    });
    $('pf-language').addEventListener('change', async () => {
      // Someone else's language is theirs: this page stays in the Admin's own.
      if (!profileOf) await setLanguage($('pf-language').value);
      saveProfile({ language: $('pf-language').value });
    });
    $('pf-tz-auto').addEventListener('change', () => {
      const auto = $('pf-tz-auto').checked;
      $('pf-tz').disabled = auto;
      // For someone else, their own computer's zone is picked up when they next sign in.
      saveProfile(auto ? (profileOf ? { timeZoneAuto: true } : { timeZoneAuto: true, timeZone: deviceTimeZone() }) : { timeZoneAuto: false, timeZone: $('pf-tz').value });
    });
    for (const id of ['pf-look', 'pf-theme', 'pf-accent']) {
      $(id).addEventListener('change', () => saveProfile({ [id.slice(3)]: $(id).value }));
    }
    $('pf-email-form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!profileOf) return;
      const email = $('pf-email-input').value.trim();
      if (email.toLowerCase() === profileOf.user.email) return;
      if (!confirm(`${profileOf.user.email} → ${email}\n\n${t('Change their sign-in email? From then on they sign in with the new address, any password reset link sent to the old one stops working, and both addresses are told.')}`)) {
        $('pf-email-input').value = profileOf.user.email;
        return;
      }
      saveProfile({ email });
    });
    $('pf-other-back').addEventListener('click', () => {
      closeProfileOf();
      location.hash = '#/access';
      loadAccess();
    });
    document.querySelector('#set-nav [data-set="profile"]')?.addEventListener('click', closeProfileOf);
    $('pf-tz').addEventListener('change', () => saveProfile({ timeZoneAuto: false, timeZone: $('pf-tz').value }));
    $('pf-currency').addEventListener('change', () => saveProfile({ impact: personalImpact() }));
    let impactTimer = null;
    $('pf-impact').addEventListener('input', (event) => {
      if (!event.target.dataset.pi) return;
      clearTimeout(impactTimer);
      if (!event.target.checkValidity()) return;
      impactTimer = setTimeout(() => saveProfile({ impact: personalImpact() }), 700);
    });
    $('pf-langs').addEventListener('change', () => {
      saveProfile({ programmingLanguages: [...$('pf-langs').querySelectorAll('input:checked')].map((box) => box.value) });
    });
    $('me-profile').addEventListener('click', () => {
      $('user-menu').open = false;
      closeProfileOf();
    });

    // A picture: cut to a square, made small here (192 px), then sent.
    $('pf-avatar-file').addEventListener('change', async () => {
      const file = $('pf-avatar-file').files[0];
      $('pf-avatar-file').value = '';
      if (!file) return;
      try {
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP picture.');
        const bitmap = await createImageBitmap(file);
        const side = Math.min(bitmap.width, bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 192;
        canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 192, 192);
        let image = canvas.toDataURL('image/webp', 0.86);
        if (!image.startsWith('data:image/webp')) image = canvas.toDataURL('image/jpeg', 0.88);
        if (profileOf) {
          profileOf = { ...profileOf, ...(await api(`/api/iam/users/${encodeURIComponent(profileOf.user.id)}/avatar`, { method: 'PUT', body: JSON.stringify({ image }) })) };
        } else {
          const me = await api('/api/me/avatar', { method: 'PUT', body: JSON.stringify({ image }) });
          state.me = { ...state.me, user: me.user };
          showAvatar($('me-avatar'), me.user);
        }
        renderProfile();
        setStatus('pf-status', 'Picture saved.', 'ok');
      } catch (error) {
        if (!handleAuthLoss(error)) showError('pf-status', error);
      }
    });
    $('pf-avatar-remove').addEventListener('click', async () => {
      try {
        if (profileOf) {
          profileOf = { ...profileOf, ...(await api(`/api/iam/users/${encodeURIComponent(profileOf.user.id)}/avatar`, { method: 'PUT', body: JSON.stringify({ image: '' }) })) };
        } else {
          const me = await api('/api/me/avatar', { method: 'PUT', body: JSON.stringify({ image: '' }) });
          state.me = { ...state.me, user: me.user };
          showAvatar($('me-avatar'), me.user);
        }
        renderProfile();
        setStatus('pf-status', 'Picture removed.', 'ok');
      } catch (error) {
        if (!handleAuthLoss(error)) showError('pf-status', error);
      }
    });
  }
}
