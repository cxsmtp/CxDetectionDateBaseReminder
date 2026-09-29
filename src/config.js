import './load-env.js';

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const trimSlash = (value) => (value ? String(value).replace(/\/+$/, '') : '');

/** Clean environment values: trim whitespace, CRLF, and surrounding quotes */
const envValue = (value) => {
  if (!value) return '';
  let clean = String(value)
    .replace(/\r\n/g, '\n')
    .replace(/[\r\n]+/g, '')
    .trim();
  // Remove surrounding quotes if present
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1).trim();
  }
  return clean;
};

/**
 * Deployment settings only.
 *
 * Credentials are *not* configured here: the API key is pasted into the portal
 * at runtime and lives in the session store.  `CX_API_KEY` remains supported
 * purely as an optional bootstrap for headless/kiosk deployments.
 */
export function loadConfig(env = process.env) {
  const bootstrapKey = envValue(env.CX_API_KEY);
  if (bootstrapKey) {
    console.log(`[CX_API_KEY] Loaded from environment (${bootstrapKey.length} chars)`);
  }

  return {
    // Optional: pre-connect a shared session at startup instead of requiring
    // someone to paste the key into the UI.
    bootstrapApiKey: bootstrapKey,

    // Optional overrides applied to every connection, for single-tenant /
    // on-prem deployments where the regional convention does not hold.
    overrides: {
      baseUrl: trimSlash(env.CX_BASE_URL?.trim()),
      iamUrl: trimSlash(env.CX_IAM_URL?.trim()),
      tenant: env.CX_TENANT?.trim() || '',
    },

    risks: {
      source: env.CX_RISK_SOURCE?.trim() || 'risk-insights',
      path: env.CX_RISKS_PATH?.trim() || '/api/risks/',
      method: (env.CX_RISKS_METHOD?.trim() || 'GET').toUpperCase(),
      autodiscover: bool(env.CX_RISKS_AUTODISCOVER, true),
    },

    // SMTP, recipients and the mail template are administrator settings,
    // configured in the UI and persisted by SettingsStore -- not env vars.
    settingsFile: env.SETTINGS_FILE?.trim() || '',

    session: { idleMs: int(env.SESSION_IDLE_MINUTES, 480) * 60_000 },
    concurrency: Math.max(1, int(env.CX_FETCH_CONCURRENCY, 5)),
    port: int(env.PORT, 3000),
    host: env.HOST?.trim() || '127.0.0.1',
  };
}

/** Deployment-level misconfiguration, independent of any connection. */
export function configProblems(config) {
  const problems = [];
  if (config.risks.source !== 'risk-insights' && config.risks.source !== 'scan-results') {
    problems.push(`CX_RISK_SOURCE="${config.risks.source}" is not one of risk-insights, scan-results.`);
  }
  return problems;
}

export const config = loadConfig();
