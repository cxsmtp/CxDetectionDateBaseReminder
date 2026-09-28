/**
 * Triage and remediation operations on Checkmarx findings.
 *
 * Triage: Mark a finding as reviewed/acknowledged.
 * Remediate: Mark a finding as fixed/resolved.
 */

import { CxApiError } from './client.js';

export const TRIAGE_STATES = {
  NOT_TRIAGED: 'NOT_TRIAGED',
  TRIAGED: 'TRIAGED',
  REMEDIATED: 'REMEDIATED',
  VERIFIED: 'VERIFIED',
};

/**
 * Update a finding's triage state through the Checkmarx API.
 *
 * The API endpoint is typically:
 * PATCH /api/risks/{riskId}
 *
 * @param {CxClient} client  Authenticated Checkmarx API client
 * @param {string} riskId    Risk/Finding ID
 * @param {string} state     New state (TRIAGED, REMEDIATED, VERIFIED)
 * @returns {object} Updated risk data
 */
export async function updateRiskState(client, riskId, state) {
  if (!riskId) throw new CxApiError('Risk ID is required.');
  if (!Object.values(TRIAGE_STATES).includes(state)) {
    throw new CxApiError(`Invalid state: ${state}. Must be one of ${Object.values(TRIAGE_STATES).join(', ')}.`);
  }

  try {
    const response = await client.request(`/api/risks/${encodeURIComponent(riskId)}`, {
      method: 'PATCH',
      body: { state },
      retries: 1,
    });
    return response;
  } catch (error) {
    if (error instanceof CxApiError) {
      // Handle common API errors
      if (error.status === 404) {
        throw new CxApiError(`Finding not found: ${riskId}`, { status: 404 });
      }
      if (error.status === 403) {
        throw new CxApiError('Permission denied. Check your API key permissions.', { status: 403 });
      }
    }
    throw error;
  }
}

/**
 * Mark a finding as triaged (reviewed/acknowledged).
 *
 * @param {CxClient} client  Authenticated Checkmarx API client
 * @param {string} riskId    Risk/Finding ID
 * @returns {object} Updated risk data
 */
export async function triageRisk(client, riskId) {
  return updateRiskState(client, riskId, TRIAGE_STATES.TRIAGED);
}

/**
 * Mark a finding as remediated (fixed/resolved).
 *
 * @param {CxClient} client  Authenticated Checkmarx API client
 * @param {string} riskId    Risk/Finding ID
 * @returns {object} Updated risk data
 */
export async function remediateRisk(client, riskId) {
  return updateRiskState(client, riskId, TRIAGE_STATES.REMEDIATED);
}

/**
 * Create a triage decision comment on a finding.
 *
 * This is useful for recording why a finding was triaged or providing
 * remediation context. The API endpoint is typically:
 * POST /api/results/{scanId}/{projectId}/{engine}?result-id={riskId}/comments
 *
 * @param {CxClient} client     Authenticated Checkmarx API client
 * @param {string} scanId       Scan ID
 * @param {string} projectId    Project ID
 * @param {string} riskId       Risk/Finding ID
 * @param {string} engine       Engine name (SAST, SCA, KICS)
 * @param {string} comment      Comment text
 * @returns {object} Comment data
 */
export async function addTriageComment(client, scanId, projectId, riskId, engine, comment) {
  if (!scanId || !projectId || !riskId || !engine || !comment) {
    throw new CxApiError('scanId, projectId, riskId, engine, and comment are required.');
  }

  try {
    const path =
      `/api/results/${encodeURIComponent(scanId)}/` +
      `${encodeURIComponent(projectId)}/${encodeURIComponent(engine)}` +
      `?result-id=${encodeURIComponent(riskId)}/comments`;

    const response = await client.request(path, {
      method: 'POST',
      body: { comment },
      retries: 1,
    });
    return response;
  } catch (error) {
    if (error instanceof CxApiError && error.status === 404) {
      throw new CxApiError(`Finding not found or comment API not available.`, { status: 404 });
    }
    throw error;
  }
}
