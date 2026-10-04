// SLAs (Beta): findings past their SLA as one issue per repository, private repositories only.
import test from 'node:test';
import assert from 'node:assert/strict';

import { cell, githubIssues, gitlabIssues, issueContent, openSlaIssues } from '../src/sla-issues.js';
import { DEFAULT_SLA, mergeSla } from '../src/sla.js';

const overdue = (id, projectId, severity = 'HIGH', title = `Finding ${id}`) => ({
  risk: { riskId: id, projectId, projectName: `Project ${projectId}`, severity, title, location: 'src/a.js', firstDetectedAt: '2026-01-01T00:00:00Z' },
  sla: { days: 30, daysLeft: -12 },
});

test('the setting is off unless switched on', () => {
  assert.equal(DEFAULT_SLA.openIssues, false);
  assert.equal(mergeSla(DEFAULT_SLA, { openIssues: true }).openIssues, true);
  assert.equal(mergeSla(DEFAULT_SLA, { openIssues: 'yes' }).openIssues, false);
});

test('text from a finding cannot mention anyone, link anywhere, add HTML or break the table', () => {
  const text = cell('@octocat <img src=x onerror=alert(1)> [click](https://evil.example) | `rm -rf` javascript:alert(1)');
  assert.ok(!/@[a-z]/i.test(text), text);
  assert.ok(!/[<>]/.test(text));
  assert.ok(!/(?<!\\)\|/.test(text), 'pipes are escaped');
  assert.ok(!/(?<!\\)\[/.test(text), 'no Markdown link');
  assert.ok(!/https:\/\//.test(text) && !/javascript:/.test(text));
  assert.equal(cell(''), '—');
  assert.equal(cell('x'.repeat(500)).length, 140);
});

test('one issue lists a project\'s findings with how far past their SLA, and only https links to Checkmarx One', () => {
  const { title, body } = issueContent('Payments', [overdue('a', 'p'), overdue('b', 'p', 'CRITICAL')], { urlOf: (r) => (r.riskId === 'a' ? 'https://eu.ast.checkmarx.net/results/a' : 'javascript:alert(1)') });
  assert.equal(title, '2 security findings past their SLA in Payments');
  assert.match(body, /\| high \| Finding a \(\[Checkmarx One\]\(https:\/\/eu\.ast\.checkmarx\.net\/results\/a\)\) \| src\/a\.js \| 2026-01-01 \| 12 \(SLA 30\) \|/);
  assert.ok(!body.includes('javascript:'));
  assert.equal(issueContent('P', [overdue('a', 'p')]).title, '1 security finding past its SLA in P');
});

function fakeHost({ isPrivate = true, fail = null } = {}) {
  const created = [];
  return {
    created,
    host: {
      async isPrivate() {
        return isPrivate;
      },
      async create(content) {
        if (fail) throw new Error(fail);
        created.push(content);
        return { url: `https://git.example/issues/${created.length}` };
      },
    },
  };
}

test('one issue per project, never in a public repository, and only what was opened is remembered', async () => {
  const priv = fakeHost();
  const pub = fakeHost({ isPrivate: false });
  const broken = fakeHost({ fail: 'Resource not accessible by integration' });
  const targets = { p1: { host: priv.host }, p2: { host: pub.host }, p3: { problem: 'No repository is linked to this project in Checkmarx One.' }, p4: { host: broken.host } };
  const items = [overdue('a', 'p1'), overdue('b', 'p1', 'CRITICAL'), overdue('c', 'p2'), overdue('d', 'p3'), overdue('e', 'p4')];
  const result = await openSlaIssues(items, { repoOf: async (id) => targets[id], urlOf: () => '' });
  assert.equal(priv.created.length, 1, 'both findings of p1 in one issue');
  assert.match(priv.created[0].title, /^2 security findings/);
  assert.equal(pub.created.length, 0);
  assert.deepEqual(result.opened.map((o) => [o.projectId, o.findings]), [['p1', 2]]);
  assert.deepEqual(Object.keys(result.issuedKeys).sort(), ['p1|a', 'p1|b']);
  const reasons = Object.fromEntries(result.skipped.map((s) => [s.projectId, s.reason]));
  assert.match(reasons.p2, /public/);
  assert.match(reasons.p3, /No repository/);
  assert.match(reasons.p4, /not accessible/);
});

test('test mode opens nothing and remembers nothing; at most N projects a run, the most severe first', async () => {
  const host = fakeHost();
  const dry = await openSlaIssues([overdue('a', 'p1')], { repoOf: async () => ({ host: host.host }), urlOf: () => '', dryRun: true });
  assert.equal(host.created.length, 0);
  assert.equal(dry.opened[0].dryRun, true);
  assert.deepEqual(dry.issuedKeys, {});

  const many = await openSlaIssues([overdue('a', 'low', 'LOW'), overdue('b', 'crit', 'CRITICAL'), overdue('c', 'med', 'MEDIUM')], { repoOf: async () => ({ host: host.host }), urlOf: () => '', max: 2 });
  assert.deepEqual(many.opened.map((o) => o.projectId).sort(), ['crit', 'med']);
  assert.match(many.skipped[0].reason, /next run/);
});

test('GitHub and GitLab adapters: visibility first, and GitLab issues are confidential', async () => {
  const calls = [];
  const gh = {
    async rest(path) {
      calls.push(['GET', path]);
      return { private: false, visibility: 'internal' };
    },
    async post(path, body) {
      calls.push(['POST', path, body.title]);
      return { html_url: 'https://github.example/o/r/issues/1' };
    },
  };
  const github = githubIssues(gh, { owner: 'o', repo: 'r' });
  assert.equal(await github.isPrivate(), true, 'internal counts as private');
  assert.deepEqual(await github.create({ title: 't', body: 'b' }), { url: 'https://github.example/o/r/issues/1' });
  assert.deepEqual(calls, [['GET', '/repos/o/r'], ['POST', '/repos/o/r/issues', 't']]);

  const sent = [];
  const gl = {
    async get() {
      return { visibility: 'public' };
    },
    async post(path, body) {
      sent.push([path, body]);
      return { web_url: 'https://gitlab.example/g/r/-/issues/1' };
    },
  };
  const gitlab = gitlabIssues(gl, { owner: 'g/sub', repo: 'r' });
  assert.equal(await gitlab.isPrivate(), false);
  await gitlab.create({ title: 't', body: 'b' });
  assert.equal(sent[0][0], '/projects/g%2Fsub%2Fr/issues');
  assert.equal(sent[0][1].confidential, true);
  assert.equal(sent[0][1].description, 'b');
});
