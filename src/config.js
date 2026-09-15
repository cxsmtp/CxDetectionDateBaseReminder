import 'dotenv/config';

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const trimSlash = (value) => (value ? String(value).replace(/\/+$/, '') : '');

/**
 * Deployment settings only.
 *
 * Credentials are *not* configured here: the API key is pasted into the portal
 * at runtime and lives in the session store.  `CX_API_KEY` remains supported
 * purely as an optional bootstrap for headless/kiosk deployments.
 */
export function loadConfig(env = process.env) {
  return {
    // Optional: pre-connect a shared session at startup instead of requiring
    // someone to paste the key into the UI.
    bootstrapApiKey: (env.CX_API_KEY ?? '').trim(),

    // Optional overrides applied to every connection, for single-tenant /
    // on-prem deployments where the regional convention does not hold.
    overrides: {
      baseUrl: trimSlash(env.CX_BASE_URL?.trim()),
      iamUrl: trimSlash(env.CX_IAM_URL?.trim()),
      tenant: env.CX_TENANT?.trim() || '',
    },

    risks: {
      source: env.CX_RISK_SOURCE?.trim() || 'risk-insights',
      path: env.CX_RISKS_PATH?.trim() || '/api/risk-management/risks/{projectId}',
      method: (env.CX_RISKS_METHOD?.trim() || 'GET').toUpperCase(),
      autodiscover: bool(env.CX_RISKS_AUTODISCOVER, true),
    },

    feedback: {
      listPath: env.CX_FEEDBACK_APPS_PATH?.trim() || '/api/feedbackapps',
      triggerPath: env.CX_FEEDBACK_APP_TRIGGER_PATH?.trim() || '/api/feedbackapps/{appId}/notify',
    },

    delivery: {
      mode: (env.REMINDER_DELIVERY_MODE?.trim() || 'auto').toLowerCase(),
      smtp: {
        host: env.SMTP_HOST?.trim() || '',
        port: int(env.SMTP_PORT, 587),
        secure: bool(env.SMTP_SECURE, false),
        user: env.SMTP_USER?.trim() || '',
        password: env.SMTP_PASSWORD ?? '',
        from: env.SMTP_FROM?.trim() || '',
      },
    },

    session: { idleMs: int(env.SESSION_IDLE_MINUTES, 480) * 60_000 },
    concurrency: Math.max(1, int(env.CX_FETCH_CONCURRENCY, 5)),
    port: int(env.PORT, 3000),
    host: env.HOST?.trim() || '127.0.0.1',
  };
}

/** Deployment-level misconfiguration, independent of any connection. */
export function configProblems(config) {
  const problems = [];
  if (config.delivery.mode === 'smtp' && !config.delivery.smtp.host) {
    problems.push('REMINDER_DELIVERY_MODE=smtp but SMTP_HOST is not set.');
  }
  if (!['auto', 'smtp', 'feedback'].includes(config.delivery.mode)) {
    problems.push(`REMINDER_DELIVERY_MODE="${config.delivery.mode}" is not one of auto, feedback, smtp.`);
  }
  return problems;
}

export const config = loadConfig();
