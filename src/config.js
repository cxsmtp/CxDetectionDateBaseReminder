import 'dotenv/config';

import { decodeApiKey } from './cxone/auth.js';

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const trimTrailingSlash = (url) => (url ? url.replace(/\/+$/, '') : url);

/**
 * A Checkmarx One API key is a JWT whose `iss` claim points at the tenant's
 * realm, e.g. https://eu.iam.checkmarx.net/auth/realms/acme.  That gives us
 * the IAM host and the tenant for free; the API host is the same region with
 * `iam` swapped for `ast`.
 */
export function deriveEndpoints(apiKey) {
  const claims = decodeApiKey(apiKey);
  const issuer = typeof claims?.iss === 'string' ? claims.iss : '';
  const match = issuer.match(/^(https?:\/\/[^/]+)\/auth\/realms\/([^/]+)/);
  if (!match) return {};

  const [, iamUrl, tenant] = match;
  const baseUrl = iamUrl.includes('.iam.') ? iamUrl.replace('.iam.', '.ast.') : iamUrl;
  return { iamUrl, tenant: decodeURIComponent(tenant), baseUrl };
}

export function loadConfig(env = process.env) {
  const apiKey = (env.CX_API_KEY ?? '').trim();
  const derived = apiKey ? deriveEndpoints(apiKey) : {};

  const iamUrl = trimTrailingSlash(env.CX_IAM_URL?.trim() || derived.iamUrl || '');
  const tenant = env.CX_TENANT?.trim() || derived.tenant || '';
  const baseUrl = trimTrailingSlash(env.CX_BASE_URL?.trim() || derived.baseUrl || '');

  return {
    apiKey,
    iamUrl,
    tenant,
    baseUrl,
    tokenUrl: iamUrl && tenant
      ? `${iamUrl}/auth/realms/${encodeURIComponent(tenant)}/protocol/openid-connect/token`
      : '',

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

    concurrency: Math.max(1, int(env.CX_FETCH_CONCURRENCY, 5)),
    port: int(env.PORT, 3000),
    host: env.HOST?.trim() || '127.0.0.1',
  };
}

/** Human-readable list of things that would stop the app from working. */
export function configProblems(config) {
  const problems = [];
  if (!config.apiKey) {
    problems.push('CX_API_KEY is not set. Generate an API key in Checkmarx One and put it in .env.');
  } else if (!config.tokenUrl) {
    problems.push(
      'Could not derive the IAM URL / tenant from CX_API_KEY. Set CX_IAM_URL and CX_TENANT explicitly.',
    );
  }
  if (!config.baseUrl) {
    problems.push('Could not derive the Checkmarx One API URL. Set CX_BASE_URL explicitly.');
  }
  if (config.delivery.mode === 'smtp' && !config.delivery.smtp.host) {
    problems.push('REMINDER_DELIVERY_MODE=smtp but SMTP_HOST is not set.');
  }
  return problems;
}

export const config = loadConfig();
