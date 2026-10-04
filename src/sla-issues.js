/**
 * SLAs (Beta), enforcement in the repository: when findings go past their SLA, open one issue
 * in the project's repository listing them, so the people who work there see it where they
 * work. Each finding is put in an issue once (a fixed finding that comes back, again).
 *
 * GitHub and GitLab only, and only private or internal repositories: an issue in a public
 * repository would publish the vulnerabilities to everyone. At most MAX_ISSUES a run.
 */

import { mapWithConcurrency } from './cxone/client.js';
import { riskKey } from './sla.js';

export const MAX_ISSUES = 20;
const MAX_ROWS = 50;

/** Text from a finding, safe inside a Markdown table cell: no mentions, links, HTML or pipes. */
export function cell(value, max = 140) {
  let text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\|/g, '\\|')
    .replace(/`/g, "'")
    .replace(/@/g, '@​') // never notifies anyone
    .replace(/\[|\]/g, (c) => `\\${c}`)
    .replace(/(https?|javascript|data):/gi, '$1​:')
    .trim();
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text || '—';
}

/** The issue for one project's findings (newlyOverdue entries). */
export function issueContent(projectName, items, { appName = 'CxMissionZero', urlOf = () => '' } = {}) {
  const n = items.length;
  const title = `${n} security finding${n === 1 ? '' : 's'} past ${n === 1 ? 'its' : 'their'} SLA in ${String(projectName || 'this project').slice(0, 80)}`;
  const rows = items.slice(0, MAX_ROWS).map(({ risk, sla }) => {
    const url = urlOf(risk);
    const link = /^https:\/\/[^\s()<>]+$/.test(url) ? ` ([Checkmarx One](${url}))` : '';
    return `| ${cell(String(risk.severity).toLowerCase(), 12)} | ${cell(risk.title)}${link} | ${cell(risk.location, 100)} | ${cell(String(risk.firstDetectedAt ?? '').slice(0, 10), 12)} | ${-sla.daysLeft} (SLA ${sla.days}) |`;
  });
  const body = [
    `These findings from Checkmarx One went past the number of days their severity has to be fixed. Each is listed once.`,
    '',
    '| Severity | Finding | Where | First found | Days past SLA |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    n > rows.length ? `\nAnd ${n - rows.length} more.` : '',
    '',
    `Fix them, or triage them in Checkmarx One (not exploitable findings have no SLA). This issue was opened by ${cell(appName, 60)}; closing it changes nothing in Checkmarx One.`,
  ].join('\n');
  return { title, body };
}

/**
 * Open the issues. `items`: newlyOverdue() entries not yet put in an issue.
 * `repoOf(projectId)` → {repo, host} | {problem}: the project's repository and a host
 *   adapter {provider, isPrivate() → bool, create({title, body}) → {url}}.
 * Returns {opened: [{project, url, findings}], skipped: [{project, reason}], issuedKeys}.
 */
export async function openSlaIssues(items, { repoOf, urlOf, appName, dryRun = false, max = MAX_ISSUES }) {
  const byProject = new Map();
  for (const item of items) {
    const id = item.risk.projectId;
    if (!byProject.has(id)) byProject.set(id, { name: item.risk.projectName || id, items: [] });
    byProject.get(id).items.push(item);
  }
  const opened = [];
  const skipped = [];
  const issuedKeys = {};
  const projects = [...byProject.entries()].sort((a, b) => worst(a[1].items) - worst(b[1].items));
  for (const [id, { name }] of projects.slice(max)) skipped.push({ project: name, projectId: id, reason: `More than ${max} projects this run: next run.` });
  await mapWithConcurrency(projects.slice(0, max), 3, async ([projectId, { name, items: list }]) => {
    let target;
    try {
      target = await repoOf(projectId);
    } catch (error) {
      target = { problem: error.message };
    }
    if (!target?.host) return skipped.push({ project: name, projectId, reason: target?.problem || 'No repository linked to this project.' });
    try {
      if (!(await target.host.isPrivate())) return skipped.push({ project: name, projectId, reason: 'The repository is public: an issue would publish the vulnerabilities.' });
      const content = issueContent(name, list, { appName, urlOf });
      if (dryRun) {
        opened.push({ project: name, projectId, url: '', findings: list.length, dryRun: true });
        return;
      }
      const { url } = await target.host.create(content);
      opened.push({ project: name, projectId, url, findings: list.length });
      for (const { risk } of list) issuedKeys[riskKey(risk)] = url || true;
    } catch (error) {
      skipped.push({ project: name, projectId, reason: String(error.message || error).slice(0, 200) });
    }
  });
  return { opened, skipped, issuedKeys };
}

const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const worst = (list) => Math.min(...list.map(({ risk }) => RANK[risk.severity] ?? 9));

/** A host adapter for a GitHub repository (`gh` a GitHubClient with a token). */
export function githubIssues(gh, { owner, repo }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    provider: 'github',
    async isPrivate() {
      const info = await gh.rest(base);
      return info?.private === true || info?.visibility === 'internal' || info?.visibility === 'private';
    },
    async create({ title, body }) {
      const issue = await gh.post(`${base}/issues`, { title, body });
      return { url: issue?.html_url ?? '' };
    },
  };
}

/** A host adapter for a GitLab project (`client` the GitLab ScmClient). */
export function gitlabIssues(client, { owner, repo }) {
  const project = encodeURIComponent(`${owner}/${repo}`);
  return {
    provider: 'gitlab',
    async isPrivate() {
      const info = await client.get(`/projects/${project}`);
      return info?.visibility === 'private' || info?.visibility === 'internal';
    },
    async create({ title, body }) {
      const issue = await client.post(`/projects/${project}/issues`, { title, description: body, confidential: true });
      return { url: issue?.web_url ?? '' };
    },
  };
}
