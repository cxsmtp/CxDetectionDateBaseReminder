// The page's entry point. Each page or concern is a module under app/. This file loads them and runs what each does
// when the page loads (its wire…() functions: listeners, the first drawing of the menu and the columns), in the order
// that code has always run in, and starts the page: the server's health, the session, the first route.

// The files that were here before app/, first and in the order they have always been imported in: they load in that order.
import './speedsters.js';
import './calculator/page.js';
import './fae-flush.js';
// Labs → Status board and Consolidated view (beta), and the tenant switcher they share.
import './status-board.js';
import './consolidated.js';
import './govern.js';
import './tenant-menu.js';
import './mobile.js';
import './nav-map.js';
import './qr.js';
import './credit-tiers.js';
import './engines.js';
import { t } from './i18n.js';
import { helpMode, setHelpMode, startHelpTips } from './help-tips.js';
import { startTableTools } from './table-tools.js';
import './column-prefs.js';
import './fusion-view.js';

// The page's own modules.
import { $, state } from './app/state.js';
import { api, setStatus, wireCore, wireLogs } from './app/core.js';
import { wireAdvancedAndFeatures, wireLayout, wireMenuAndTabs, wirePagesAndPalette } from './app/nav.js';
import { applyAppBranding, languagesChanged, wireAppBranding, wireLanguageAndProfile, wireMyBranding, wireThemeAndLook } from './app/profile.js';
import { afterSignIn, resetLinkToken, showReset, showSignIn, showSsoRefusal, ssoRefusalCode, wireConnections, wireSignIn, wireTerms } from './app/session.js';
import { wireSettings, wireSettingsChecks, wireSupportNote } from './app/settings.js';
import { wireAboutAndUpdates, wireActivationAndTenants, wireHttps, wireServerConnections } from './app/system.js';
import { wireAutomation, wireAutomationRun, wireHandsOff } from './app/automation.js';
import { fillAgePresets, fillPresets, renderEnginePick, renderFocusPick, syncNarrow, updateScopeSummary, wireActionRail, wireFetch, wireFetchStop, wireGettingStarted, wireScope } from './app/workbench.js';
import { wireColumns, wireProjectFilters, wireProjectRows, wireSortAndInitiators } from './app/projects.js';
import { wireAllocation, wireReminders } from './app/actions.js';
import { wireReports, wireRescanLinks } from './app/reports.js';
import { wireHelp } from './app/help.js';
import { wireFusionAndAuthors, wireGitHosts } from './app/labs.js';
import { wireAudit } from './app/audit.js';
import { wireAccess } from './app/access.js';
import { wireCreditControl, wireCreditPool, wireTakeBack } from './app/credits.js';
import { wireImpact } from './app/impact.js';

wireCore();
wireAdvancedAndFeatures();
wireHandsOff();
wireMyBranding();
wireActivationAndTenants();
wireMenuAndTabs();
wireThemeAndLook();
wireConnections();
wireAutomation();
wireSupportNote();
wireCreditPool();
wireSettings();
wireScope();
wireColumns();
wireRescanLinks();
wireFetchStop();
wireSignIn();
wireFetch();
wireProjectFilters();
wireReminders();
wireAutomationRun();
wireSettingsChecks();
wireSortAndInitiators();
wireAllocation();
wireReports();
wireProjectRows();
wireLogs();
wireAppBranding();
wireActionRail();
wireAboutAndUpdates();
wireGettingStarted();
wireHelp();
wirePagesAndPalette();

(async function init() {
  // Sort and filter from the column headings, on every data table (public/table-tools.js).
  startTableTools({ translate: t });
  // Explanations behind a "?" (or shown, as chosen under Settings → Your appearance; kept in this browser).
  setHelpMode(helpMode());
  for (const radio of document.querySelectorAll('input[name="look-help"]')) {
    radio.checked = radio.value === helpMode();
    radio.addEventListener('change', () => radio.checked && setHelpMode(radio.value));
  }
  startHelpTips({ translate: t });
  try {
    state.health = await api('/api/health');
    if (Array.isArray(state.health.languages)) languagesChanged(state.health.languages);
    if (state.health.version) {
      $('app-version').textContent = state.health.version;
      $('app-version').hidden = false;
    }
    applyAppBranding(state.health.app);
    for (const problem of state.health.problems) console.warn(problem);
    syncNarrow();
    // Every open finding, whatever its age, in the projects scanned in the last 90 days: the old findings are
    // what this is for, and a project nobody scans any more is skipped (Narrow down changes that).
    fillPresets('activity-preset', '90d');
    // (A first load starts with what is new this week; a load made before brings back what it was made with.)
    fillAgePresets('7d');
    renderEnginePick();
    renderFocusPick();
    updateScopeSummary();
  } catch {
    /* health is advisory only */
  }

  // Opened from an emailed reset link: that comes first, signed in or not (using it signs everyone out).
  const token = resetLinkToken();
  if (token) return showReset(token);
  // Back from the identity provider without a sign-in: the reason, by its code, once the page knows nobody is signed in.
  const ssoRefused = ssoRefusalCode();
  if (ssoRefused) history.replaceState(null, '', location.pathname + location.search);
  try {
    const session = await api('/api/session');
    if (session.signedIn) await afterSignIn(session);
    else {
      showSignIn({ setup: session.setup });
      if (ssoRefused) showSsoRefusal(ssoRefused);
      if (session.firstStart) {
        setStatus('signin-status', 'First start: sign in with the administrator email and password printed in the server (container) log.', 'ok');
      }
    }
  } catch (error) {
    showSignIn({ message: error.message });
  }
})();

wireFusionAndAuthors();
wireAudit();
wireServerConnections();
wireAccess();
wireTakeBack();
wireImpact();
wireCreditControl();
wireHttps();
wireTerms();
wireGitHosts();
wireLayout();
wireLanguageAndProfile();
