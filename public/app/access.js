// People & roles: people, roles and the permission matrix, sign-in policy, two-step and single sign-on.
import { sortAndFilter } from '../table-tools.js';
import { $, can, state } from './state.js';
import { escapeHtml, formatTime } from './format.js';
import { api, handleAuthLoss, setStatus, showError } from './core.js';
import { applyPermissions } from './nav.js';
import { openProfileOf } from './profile.js';
import { copyButton } from './session.js';

// ---------------------------------------------------------------------------
// Access: people, roles and the permission matrix
// ---------------------------------------------------------------------------

export const access = { data: null, edits: new Map() };

export async function loadAccess() {
  setStatus('iam-status', '');
  try {
    access.data = await api('/api/iam');
    access.edits.clear();
    renderAccess();
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-status', error);
  }
}

function roleName(id) {
  return access.data?.roles.find((r) => r.id === id)?.name ?? id;
}

/** What each heading of the people table reads (sorting and the heading filters cover everyone, not one page). */
const IAM_COLUMNS = [
  (u) => `${u.name || ''} ${u.email}`.trim(),
  (u) => roleName(u.role),
  (u) => [u.hasPassword ? (u.twoStep ? 'Password and two-step code' : 'Password') : '', 'Checkmarx One', ...(u.cxoneIdentities ?? [])].filter(Boolean).join(' '),
  (u) => (u.disabled ? 'Disabled' : u.locked ? 'Locked' : u.mustChangePassword ? 'Must set password' : 'Active'),
  { value: (u) => Date.parse(u.lastLoginAt) || null, text: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '') },
  null,
];

/** People & roles → Sign-in: who may reset a forgotten password by email, and what is missing for it to work. */
function renderSignInPolicy() {
  const policy = access.data?.signIn;
  if (!policy) return;
  $('iam-reset-policy').value = policy.policy;
  $('iam-reset-policy').disabled = !policy.canChange;
  if (!policy.canChange) setStatus('iam-reset-status', 'Sign-in rules are for the whole server: a Super Admin changes them.');
  const missing = (policy.missing ?? []).filter((m) => m !== 'Turned off.');
  $('iam-reset-missing').hidden = !missing.length || policy.policy === 'off';
  $('iam-reset-missing').innerHTML = missing.length
    ? `<li class="hint">"Forgot your password?" is not shown yet:</li>${missing.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}`
    : '';
  renderSignInSecurity();
}

/** People & roles → Sign-in, for Admins: two-step sign-in for everyone. */
function renderSignInSecurity() {
  const security = access.data?.signIn?.security;
  $('iam-twostep-panel').hidden = !security;
  $('iam-sso-panel').hidden = !security;
  if (!security) return;
  $('iam-twostep-required').checked = security.twoStepRequired;
  renderSsoSettings(security);
}

// ---- People & roles → Sign-in → Single sign-on (Admins) ----

/** What the form was last filled from, so that typing is not overwritten each time the page is drawn again. */
let ssoFilledFrom = '';

function renderSsoSettings(security) {
  const { sso } = security;
  $('sso-redirect').value = security.redirectUri || '';
  $('sso-redirect').placeholder = 'Set this server\'s address first (Settings → Server address)';
  $('sso-secret-state').textContent = sso.clientSecretSet ? '(stored)' : '(not set)';
  $('sso-secret-remove').hidden = !sso.clientSecretSet;
  const missing = sso.enabled ? security.missing ?? [] : [];
  $('sso-missing').hidden = !missing.length;
  $('sso-missing').innerHTML = missing.length ? `<li class="hint">The button is not shown on the sign-in page yet:</li>${missing.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}` : '';
  const from = JSON.stringify([sso, security.roles]);
  if (from === ssoFilledFrom) return;
  ssoFilledFrom = from;
  $('sso-enabled').checked = sso.enabled;
  $('sso-issuer').value = sso.issuer;
  $('sso-label').value = sso.label;
  $('sso-client-id').value = sso.clientId;
  $('sso-client-secret').value = '';
  $('sso-domains').value = (sso.domains ?? []).join(', ');
  $('sso-provision').value = sso.provision;
  $('sso-role').innerHTML = (security.roles ?? []).map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');
  $('sso-role').value = (security.roles ?? []).some((r) => r.id === sso.role) ? sso.role : 'user';
  $('sso-verified').checked = sso.requireVerifiedEmail;
  $('sso-password-admins').checked = sso.passwordAdminsOnly;
  syncSsoForm();
}

/** The role is chosen only when people are added; passwords can be kept for Admins only while single sign-on is on. */
function syncSsoForm() {
  $('sso-role-field').hidden = $('sso-provision').value !== 'create';
  $('sso-password-admins').disabled = !$('sso-enabled').checked;
  if (!$('sso-enabled').checked) $('sso-password-admins').checked = false;
}

async function saveSso(sso, done) {
  setStatus('sso-admin-status', 'Saving…');
  try {
    access.data = await api('/api/iam/sign-in', { method: 'PUT', body: JSON.stringify({ sso }) });
    ssoFilledFrom = '';
    renderAccess();
    setStatus('sso-admin-status', done, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('sso-admin-status', error);
  }
}

function renderAccess() {
  renderSignInPolicy();
  const { users, roles } = access.data;
  const assignable = roles.filter((r) => r.canAssign);
  $('iam-add-role').innerHTML = assignable.map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === 'user' ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');

  const roleFilter = $('iam-role-filter');
  const chosenRole = roleFilter.value;
  roleFilter.innerHTML = `<option value="">All roles</option>${roles.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('')}`;
  roleFilter.value = roles.some((r) => r.id === chosenRole) ? chosenRole : '';
  $('iam-people-count').textContent = String(users.length);
  $('iam-roles-count').textContent = String(roles.length);
  const shown = sortAndFilter('iam-people', users.filter(iamUserMatches), IAM_COLUMNS, () => {
    access.page = 0;
    renderAccess();
  });
  const pages = Math.max(1, Math.ceil(shown.length / IAM_PAGE));
  access.page = Math.min(access.page ?? 0, pages - 1);
  const first = access.page * IAM_PAGE;
  $('iam-count').textContent = shown.length === users.length ? `${users.length} ${users.length === 1 ? 'person' : 'people'}` : `${shown.length} of ${users.length} people`;
  $('iam-pager').hidden = pages < 2;
  $('iam-page-info').textContent = `${first + 1}–${Math.min(first + IAM_PAGE, shown.length)} of ${shown.length}`;
  $('iam-prev').disabled = access.page === 0;
  $('iam-next').disabled = access.page >= pages - 1;
  if (!shown.length) {
    $('iam-users').innerHTML = '<tr><td colspan="6" class="hint">Nobody matches these filters.</td></tr>';
    renderMatrix();
    return;
  }
  $('iam-users').innerHTML = shown
    .slice(first, first + IAM_PAGE)
    .map((u) => {
      const me = u.id === state.me.user.id;
      const status = u.disabled ? '<span class="badge bad">Disabled</span>' : u.locked ? '<span class="badge warn">Locked</span>' : u.mustChangePassword ? '<span class="badge muted">Must set password</span>' : '<span class="badge">Active</span>';
      const methods = [u.hasPassword ? (u.twoStep ? 'Password and two-step code' : 'Password') : '', `Checkmarx One: ${[u.email, ...u.cxoneIdentities].map(escapeHtml).join(', ')}`].filter(Boolean).join('<br>');
      const roleCell = u.canManage
        ? `<select data-iam-role="${u.id}" aria-label="Role of ${escapeHtml(u.email)}">${roles
            .filter((r) => r.canAssign || r.id === u.role)
            .map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === u.role ? 'selected' : ''} ${r.canAssign ? '' : 'disabled'}>${escapeHtml(r.name)}</option>`)
            .join('')}</select>`
        : `<span class="role-pill role-${escapeHtml(u.role)}">${escapeHtml(roleName(u.role))}</span>`;
      const actions = u.canManage
        ? `<button type="button" class="link" data-iam-profile="${u.id}">Edit profile</button>
           <button type="button" class="link" data-iam-reset="${u.id}">Set password</button>
           ${u.twoStep ? `<button type="button" class="link" data-iam-twostep="${u.id}">Reset two-step</button>` : ''}
           ${u.ssoLinked ? ssoLinkButton(u) : ''}
           <button type="button" class="link" data-iam-ids="${u.id}">Identities</button>
           <button type="button" class="link" data-iam-toggle="${u.id}">${u.disabled ? 'Enable' : 'Disable'}</button>
           <button type="button" class="link danger" data-iam-delete="${u.id}">Remove</button>`
        : me ? `<span class="hint">You</span>${u.ssoLinked && can('iam.manage') ? ` ${ssoLinkButton(u)}` : ''}` : '';
      // Several tenants: where each person works, chosen by a Super Admin.
      const tenants = access.data.tenants;
      const theirs = u.tenants?.length ? u.tenants : ['default'];
      const tenantLine = tenants ? `<small class="muted block" translate="no">${escapeHtml(tenants.filter((t) => theirs.includes(t.id)).map((t) => t.name).join(', '))}</small>` : '';
      const tenantPick = tenants && u.canManage
        ? `<details class="tn-pick"><summary class="link">Tenants</summary><div class="tn-pop">${tenants
            .map((t) => `<label class="check"><input type="checkbox" value="${escapeHtml(t.id)}" ${theirs.includes(t.id) ? 'checked' : ''} /> <span translate="no">${escapeHtml(t.name)}</span></label>`)
            .join('')}<button type="button" class="sm primary" data-iam-tenants="${u.id}">Save</button></div></details>`
        : '';
      return `<tr>
        <td><strong>${escapeHtml(u.name || u.email)}</strong>${u.name ? `<small class="muted block">${escapeHtml(u.email)}</small>` : ''}${tenantLine}</td>
        <td>${roleCell}</td>
        <td class="small-text">${methods}</td>
        <td>${status}</td>
        <td class="when">${u.lastLoginAt ? escapeHtml(formatTime(u.lastLoginAt)) : '<span class="hint">never</span>'}</td>
        <td><div class="row-actions">${actions}${tenantPick}${consolidatedTick(u, me)}</div></td>
      </tr>`;
    })
    .join('');
  renderMatrix();
}

const IAM_PAGE = 20;

/** For a person linked to their account at the identity provider by a single sign-on: take the link off (the account there was made anew). */
const ssoLinkButton = (u) => `<button type="button" class="link" data-iam-ssolink="${u.id}">Reset single sign-on link</button>`;

/**
 * Labs → Consolidated view: the Admin's tick, one person at a time (never through a role). Shown once its activation
 * code is applied; others see who has it.
 */
function consolidatedTick(u, me) {
  if (access.data.consolidatedGrant && (u.canManage || me)) {
    return `<label class="check cv-grant" title="Labs → Consolidated view: every tenant they work in, read only. Each visit is written to each tenant's audit log. Their role also needs See Labs and Labs: Consolidated view."><input type="checkbox" data-iam-consolidated="${escapeHtml(u.id)}" ${u.consolidated ? 'checked' : ''} /> <span>May see the consolidated view (all connected tenants)</span></label>`;
  }
  return u.consolidated ? '<span class="badge gv-info" title="May see the consolidated view (all connected tenants)">Consolidated view</span>' : '';
}

function iamUserMatches(u) {
  const q = $('iam-search').value.trim().toLowerCase();
  const role = $('iam-role-filter').value;
  const status = $('iam-status-filter').value;
  if (role && u.role !== role) return false;
  if (status) {
    const current = u.disabled ? 'disabled' : u.locked ? 'locked' : u.mustChangePassword ? 'pending' : 'active';
    if (current !== status) return false;
  }
  if (!q) return true;
  return [u.name, u.email, ...(u.cxoneIdentities ?? [])].some((v) => String(v ?? '').toLowerCase().includes(q));
}

/** Permission groups folded away in the matrix (this browser session). */
const collapsedGroups = new Set();

/** "Show only the differences": the roles being compared (two or more; none chosen = every role). */
const roleCompare = { on: false, roles: new Set() };

function comparedRoles(roles) {
  const chosen = roles.filter((r) => roleCompare.roles.has(r.id));
  return chosen.length >= 2 ? chosen : roles;
}

/** Permissions down the side, roles across the top; tick to change what a role may do. */
function renderMatrix() {
  const { permissions, me } = access.data;
  const mine = new Set(me.permissions);
  const roles = roleCompare.on ? comparedRoles(access.data.roles) : access.data.roles;
  const groups = [...new Set(permissions.map((p) => p.group))];
  const valueOf = (role, pid) => (access.edits.get(role.id) ?? new Set(role.permissions)).has(pid);
  const differs = (p) => new Set(roles.map((r) => valueOf(r, p.id))).size > 1;
  const roleActions = (r) =>
    [
      r.canManage ? `<button type="button" class="link" data-iam-role-rename="${escapeHtml(r.id)}">Rename</button>` : '',
      access.data.rolesChangeable ? `<button type="button" class="link" data-iam-role-copy="${escapeHtml(r.id)}">Duplicate</button>` : '',
      r.canManage && !r.builtin ? `<button type="button" class="link danger" data-iam-role-delete="${escapeHtml(r.id)}">Remove</button>` : '',
    ].filter(Boolean);
  const head = `<thead><tr><th>Permission</th>${roles
    .map((r) => {
      const actions = roleActions(r);
      return `<th class="role-col" title="${escapeHtml(r.description || '')}"><span class="role-pill role-${escapeHtml(r.id)}">${escapeHtml(r.name)}</span><small>${r.users} ${r.users === 1 ? 'person' : 'people'}${r.locked ? ' · fixed' : ''}</small>${
        actions.length ? `<span class="role-actions">${actions.join('')}</span>` : ''
      }</th>`;
    })
    .join('')}</tr></thead>`;
  let differing = 0;
  const body = groups
    .map((group) => {
      const q = $('iam-perm-search').value.trim().toLowerCase();
      const inGroup = permissions.filter((p) => p.group === group && (!q || `${p.label} ${p.description} ${p.id}`.toLowerCase().includes(q)) && (!roleCompare.on || differs(p)));
      if (!inGroup.length) return '';
      differing += inGroup.length;
      const folded = collapsedGroups.has(group) && !q && !roleCompare.on;
      const granted = roles.map((r) => inGroup.filter((p) => valueOf(r, p.id)).length);
      const rows = folded ? '' : inGroup
        .map((p) => `<tr${roleCompare.on ? ' class="differs"' : ''}><td><span class="perm-label">${escapeHtml(p.label)}${p.adminOnly ? ' <span class="badge warn">Admin role only</span>' : p.special ? ' <span class="badge warn">Admin</span>' : ''}</span><small class="perm-desc">${escapeHtml(p.description)}</small></td>${roles
          .map((r) => {
            // An Admin-role-only permission (deleting reports) is never given to another role.
            const editable = r.canManage && mine.has(p.id) && !p.adminOnly;
            const checked = valueOf(r, p.id);
            return `<td class="cell${roleCompare.on ? (checked ? ' has' : ' lacks') : ''}"><input type="checkbox" data-matrix-role="${escapeHtml(r.id)}" data-matrix-perm="${escapeHtml(p.id)}" ${checked ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="${escapeHtml(r.name)}: ${escapeHtml(p.label)}" /></td>`;
          })
          .join('')}</tr>`)
        .join('');
      return `<tbody><tr class="group-row${folded ? ' folded' : ''}"><th><button type="button" class="group-toggle" data-iam-group="${escapeHtml(group)}" aria-expanded="${!folded}">${escapeHtml(group)} <span class="muted">${inGroup.length}</span></button></th>${granted
        .map((n) => `<td class="cell group-sum"><span class="muted">${n}/${inGroup.length}</span></td>`)
        .join('')}</tr>${rows}</tbody>`;
    })
    .join('');
  const empty = roleCompare.on && !$('iam-perm-search').value.trim() ? 'These roles hold the same permissions.' : 'No permission matches.';
  $('iam-matrix').innerHTML = head + (body || `<tbody><tr><td colspan="${roles.length + 1}" class="hint">${empty}</td></tr></tbody>`);
  $('iam-groups-toggle').textContent = collapsedGroups.size >= groups.length ? 'Expand all' : 'Collapse all';
  $('iam-groups-toggle').disabled = roleCompare.on;
  $('iam-matrix-actions').hidden = access.edits.size === 0;
  renderRoleCompare(roles, differing);
}

/** The roles to compare, as tick boxes, and how many permissions differ between them. */
function renderRoleCompare(shown, differing) {
  $('iam-diff').checked = roleCompare.on;
  $('iam-compare').hidden = !roleCompare.on;
  if (!roleCompare.on) return;
  const ids = new Set(shown.map((r) => r.id));
  $('iam-compare-roles').innerHTML = access.data.roles
    .map((r) => `<label class="check"><input type="checkbox" data-iam-compare="${escapeHtml(r.id)}" ${roleCompare.roles.has(r.id) || (ids.has(r.id) && roleCompare.roles.size < 2) ? 'checked' : ''} /> <span class="role-pill role-${escapeHtml(r.id)}">${escapeHtml(r.name)}</span></label>`)
    .join('');
  $('iam-compare-note').textContent = differing === 1 ? '1 permission differs.' : `${differing} permissions differ.`;
}

/** My own permissions may have changed (e.g. I edited my role). */
async function refreshMe() {
  try {
    state.me = await api('/api/me');
    applyPermissions();
  } catch {}
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
}

/** The role form: a new role, a copy of one (same permissions, nobody has it yet), or renaming one. */
const roleForm = { mode: 'new', id: null };

/** "Security Analyst (copy)", or "(copy 2)" and on when that name is taken. */
function copyName(name) {
  const taken = new Set(access.data.roles.map((r) => r.name.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = `${name} (copy${n > 1 ? ` ${n}` : ''})`.slice(0, 60);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function openRoleForm(mode, role = null) {
  roleForm.mode = mode;
  roleForm.id = role?.id ?? null;
  $('iam-role-form-title').textContent = { new: 'New role', copy: 'Duplicate role', rename: 'Rename role' }[mode];
  $('iam-role-form-of').hidden = !role;
  $('iam-role-form-of').textContent = role?.name ?? '';
  $('iam-role-submit').textContent = { new: 'Create role', copy: 'Create copy', rename: 'Save' }[mode];
  $('iam-role-hint').textContent = {
    new: 'Then tick its permissions in the matrix.',
    copy: 'The copy starts with the same permissions. Nobody has it until you give it to someone.',
    rename: 'The people with this role keep it, and its permissions stay as they are.',
  }[mode];
  $('iam-role-name').value = mode === 'rename' ? role.name : mode === 'copy' ? copyName(role.name) : '';
  $('iam-role-desc').value = role?.description ?? '';
  setStatus('iam-role-status', '');
  $('iam-role-form').hidden = false;
  $('iam-role-name').focus();
  $('iam-role-name').select();
}
function closeRoleForm() {
  $('iam-role-form').hidden = true;
  roleForm.mode = 'new';
  roleForm.id = null;
}

async function iamCall(path, options, done = '') {
  try {
    access.data = await api(path, options);
    renderAccess();
    setStatus('iam-status', done, 'ok');
  } catch (error) {
    if (!handleAuthLoss(error)) showError('iam-status', error);
    renderAccess();
  }
}

export function wireAccess() {
  {
    $('sso-provision').addEventListener('change', syncSsoForm);
    $('sso-enabled').addEventListener('change', syncSsoForm);
    $('iam-sso-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const secret = $('sso-client-secret').value;
      saveSso(
        {
          enabled: $('sso-enabled').checked,
          issuer: $('sso-issuer').value.trim(),
          label: $('sso-label').value.trim(),
          clientId: $('sso-client-id').value.trim(),
          // Left empty, the stored secret is kept.
          ...(secret ? { clientSecret: secret } : {}),
          domains: $('sso-domains').value,
          provision: $('sso-provision').value,
          role: $('sso-role').value,
          requireVerifiedEmail: $('sso-verified').checked,
          passwordAdminsOnly: $('sso-password-admins').checked,
        },
        'Saved.',
      );
    });
    $('sso-secret-remove').addEventListener('click', () => {
      if (!confirm('Remove the stored client secret? Single sign-on stops working until a new one is saved, unless the identity provider needs none.')) return;
      saveSso({ clientSecret: null }, 'The client secret was removed.');
    });
    $('sso-check').addEventListener('click', async () => {
      setStatus('sso-admin-status', 'Checking the identity provider as saved…');
      try {
        const result = await api('/api/iam/sign-in/sso/check', { method: 'POST' });
        setStatus('sso-admin-status', result.message, result.ok ? 'ok' : 'error');
      } catch (error) {
        if (!handleAuthLoss(error)) showError('sso-admin-status', error);
      }
    });
    copyButton($('sso-redirect-copy'), $('sso-admin-status'), () => $('sso-redirect').value);
  }

  $('iam-twostep-required').addEventListener('change', async () => {
    const on = $('iam-twostep-required').checked;
    if (on && !confirm('Require two-step sign-in for everyone who signs in with a password? Each person without it sets it up at their next sign-in, you included.')) {
      $('iam-twostep-required').checked = false;
      return;
    }
    setStatus('iam-twostep-status', 'Saving…');
    try {
      access.data = await api('/api/iam/sign-in', { method: 'PUT', body: JSON.stringify({ twoStepRequired: on }) });
      renderAccess();
      setStatus('iam-twostep-status', 'Saved.', 'ok');
      if (state.me?.twoStep) state.me = { ...state.me, twoStep: { ...state.me.twoStep, required: on } };
    } catch (error) {
      if (!handleAuthLoss(error)) showError('iam-twostep-status', error);
      renderSignInSecurity();
    }
  });

  $('iam-reset-policy').addEventListener('change', async () => {
    setStatus('iam-reset-status', 'Saving…');
    try {
      const ready = await api('/api/iam/policy', { method: 'PUT', body: JSON.stringify({ passwordReset: $('iam-reset-policy').value }) });
      access.data.signIn = { ...access.data.signIn, ...ready };
      renderSignInPolicy();
      setStatus('iam-reset-status', 'Saved.', 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('iam-reset-status', error);
      if (access.data?.signIn) $('iam-reset-policy').value = access.data.signIn.policy;
    }
  });

  $('iam-users').addEventListener('change', (event) => {
    const box = event.target.closest('[data-iam-consolidated]');
    if (!box) return;
    const user = access.data.users.find((u) => u.id === box.dataset.iamConsolidated);
    if (!user) return;
    iamCall(`/api/iam/users/${encodeURIComponent(user.id)}/consolidated`, { method: 'PUT', body: JSON.stringify({ on: box.checked }) }, box.checked ? `${user.email} may now see the consolidated view.` : `${user.email} may no longer see the consolidated view.`);
  });

  for (const id of ['iam-search', 'iam-role-filter', 'iam-status-filter']) {
    $(id).addEventListener(id === 'iam-search' ? 'input' : 'change', () => {
      access.page = 0;
      if (access.data) renderAccess();
    });
  }
  $('iam-prev').addEventListener('click', () => {
    access.page = Math.max(0, (access.page ?? 0) - 1);
    renderAccess();
  });
  $('iam-next').addEventListener('click', () => {
    access.page = (access.page ?? 0) + 1;
    renderAccess();
  });

  $('iam-diff').addEventListener('change', () => {
    roleCompare.on = $('iam-diff').checked;
    if (access.data) renderMatrix();
  });
  $('iam-compare-roles').addEventListener('change', (event) => {
    const box = event.target.closest('[data-iam-compare]');
    if (!box) return;
    // Starting from "every role": the first untick keeps the others.
    if (roleCompare.roles.size < 2) roleCompare.roles = new Set(comparedRoles(access.data.roles).map((r) => r.id));
    if (box.checked) roleCompare.roles.add(box.dataset.iamCompare);
    else roleCompare.roles.delete(box.dataset.iamCompare);
    if (roleCompare.roles.size < 2) {
      box.checked = true;
      roleCompare.roles.add(box.dataset.iamCompare);
      return setStatus('iam-matrix-status', 'Compare at least two roles.', 'error');
    }
    setStatus('iam-matrix-status', '');
    renderMatrix();
  });

  $('iam-matrix').addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-iam-group]');
    if (!toggle) return;
    const group = toggle.dataset.iamGroup;
    if (collapsedGroups.has(group)) collapsedGroups.delete(group);
    else collapsedGroups.add(group);
    renderMatrix();
  });
  $('iam-perm-search').addEventListener('input', () => access.data && renderMatrix());
  $('iam-groups-toggle').addEventListener('click', () => {
    const groups = [...new Set(access.data?.permissions.map((p) => p.group) ?? [])];
    if (collapsedGroups.size >= groups.length) collapsedGroups.clear();
    else for (const g of groups) collapsedGroups.add(g);
    renderMatrix();
  });

  $('iam-matrix').addEventListener('change', (event) => {
    const box = event.target.closest('[data-matrix-role]');
    if (!box) return;
    const role = access.data.roles.find((r) => r.id === box.dataset.matrixRole);
    const set = access.edits.get(role.id) ?? new Set(role.permissions);
    if (box.checked) set.add(box.dataset.matrixPerm);
    else set.delete(box.dataset.matrixPerm);
    const unchanged = set.size === role.permissions.length && role.permissions.every((p) => set.has(p));
    if (unchanged) access.edits.delete(role.id);
    else access.edits.set(role.id, set);
    $('iam-matrix-actions').hidden = access.edits.size === 0;
    setStatus('iam-matrix-status', access.edits.size ? `Unsaved changes to ${[...access.edits.keys()].map(roleName).join(', ')}.` : '');
  });

  $('iam-matrix-cancel').addEventListener('click', () => {
    access.edits.clear();
    renderMatrix();
    setStatus('iam-matrix-status', '');
  });

  $('iam-matrix-save').addEventListener('click', async () => {
    try {
      for (const [id, set] of access.edits) {
        const role = access.data.roles.find((r) => r.id === id);
        access.data = await api(`/api/iam/roles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name: role.name, description: role.description, permissions: [...set] }) });
      }
      access.edits.clear();
      renderAccess();
      setStatus('iam-matrix-status', 'Saved — it applies at once to everyone with these roles.', 'ok');
      refreshMe();
    } catch (error) {
      if (!handleAuthLoss(error)) showError('iam-matrix-status', error);
    }
  });

  $('iam-add-toggle').addEventListener('click', () => {
    $('iam-add-form').hidden = !$('iam-add-form').hidden;
    if (!$('iam-add-form').hidden) $('iam-add-email').focus();
  });
  $('iam-generate').addEventListener('click', () => {
    $('iam-add-password').value = generatePassword();
  });

  $('iam-add-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      access.data = await api('/api/iam/users', {
        method: 'POST',
        body: JSON.stringify({
          email: $('iam-add-email').value.trim(),
          name: $('iam-add-name').value.trim(),
          role: $('iam-add-role').value,
          password: $('iam-add-password').value,
          cxoneIdentities: $('iam-add-cx').value,
        }),
      });
      const password = $('iam-add-password').value;
      setStatus('iam-add-status', password ? `Added. Give them their temporary password: ${password}` : 'Added. They sign in with a Checkmarx One key.', 'ok');
      for (const id of ['iam-add-email', 'iam-add-name', 'iam-add-password', 'iam-add-cx']) $(id).value = '';
      renderAccess();
    } catch (error) {
      if (!handleAuthLoss(error)) showError('iam-add-status', error);
    }
  });

  $('iam-role-new').addEventListener('click', () => {
    if (!$('iam-role-form').hidden && roleForm.mode === 'new') closeRoleForm();
    else openRoleForm('new');
  });
  $('iam-role-cancel').addEventListener('click', closeRoleForm);
  $('iam-role-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('iam-role-name').value.trim();
    const description = $('iam-role-desc').value.trim();
    const role = access.data.roles.find((r) => r.id === roleForm.id);
    const mine = new Set(access.data.me.permissions);
    const adminOnly = new Set(access.data.permissions.filter((p) => p.adminOnly).map((p) => p.id));
    try {
      if (roleForm.mode === 'rename' && role) {
        // The saved permissions go back unchanged; ticks not saved yet stay in the matrix.
        access.data = await api(`/api/iam/roles/${encodeURIComponent(role.id)}`, { method: 'PUT', body: JSON.stringify({ name, description, permissions: role.permissions }) });
      } else {
        // A copy holds what the original holds, less anything only the Admin role may hold or that you do not hold yourself.
        const permissions = roleForm.mode === 'copy' && role ? role.permissions.filter((p) => mine.has(p) && !adminOnly.has(p)) : [];
        access.data = await api('/api/iam/roles', { method: 'POST', body: JSON.stringify({ name, description, permissions }) });
      }
      const done = { new: 'Role created — tick its permissions in its column, then save.', copy: 'Copy created — change its permissions in its column, then save.', rename: 'Renamed.' }[roleForm.mode];
      closeRoleForm();
      renderAccess();
      setStatus('iam-matrix-status', done, 'ok');
    } catch (error) {
      if (!handleAuthLoss(error)) showError('iam-role-status', error);
    }
  });

  $('iam-users').addEventListener('change', (event) => {
    const select = event.target.closest('[data-iam-role]');
    if (!select) return;
    const user = access.data.users.find((u) => u.id === select.dataset.iamRole);
    iamCall(`/api/iam/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) }, `${user.email} is now ${roleName(select.value)}.`);
  });

  $('iam-users').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const id = button.dataset.iamProfile || button.dataset.iamReset || button.dataset.iamTwostep || button.dataset.iamSsolink || button.dataset.iamIds || button.dataset.iamToggle || button.dataset.iamDelete || button.dataset.iamTenants;
    const user = access.data.users.find((u) => u.id === id);
    if (!user) return;
    if (button.dataset.iamProfile) {
      openProfileOf(id);
    } else if (button.dataset.iamTenants) {
      const tenants = [...button.closest('.tn-pop').querySelectorAll('input:checked')].map((input) => input.value);
      if (!tenants.length) return setStatus('iam-status', 'Choose at least one tenant.', 'error');
      iamCall(`/api/iam/users/${id}/tenants`, { method: 'PUT', body: JSON.stringify({ tenants }) }, 'Saved.');
    } else if (button.dataset.iamReset) {
      const password = generatePassword();
      if (!confirm(`Set a temporary password for ${user.email}? They are signed out and choose their own at next sign-in.`)) return;
      iamCall(`/api/iam/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }, `Temporary password for ${user.email}: ${password}`);
    } else if (button.dataset.iamTwostep) {
      if (!confirm(`Reset two-step sign-in for ${user.email}? Their authenticator app and recovery codes stop working here, and they set it up again.`)) return;
      iamCall(`/api/iam/users/${id}/two-step`, { method: 'DELETE' }, `Two-step sign-in was reset for ${user.email}.`);
    } else if (button.dataset.iamSsolink) {
      if (!confirm(`Reset the single sign-on link of ${user.email}? Do this when their account at the identity provider was made anew. Their next single sign-on links them again, by their email address.`)) return;
      iamCall(`/api/iam/users/${id}/sso-link`, { method: 'DELETE' }, `The single sign-on link of ${user.email} was reset.`);
    } else if (button.dataset.iamIds) {
      const value = prompt(`Checkmarx One identities that sign in as ${user.email} — Checkmarx One usernames, comma separated (their email always counts):`, user.cxoneIdentities.join(', '));
      if (value === null) return;
      iamCall(`/api/iam/users/${id}`, { method: 'PATCH', body: JSON.stringify({ cxoneIdentities: value }) }, 'Saved.');
    } else if (button.dataset.iamToggle) {
      if (!user.disabled && !confirm(`Disable ${user.email}? They are signed out at once.`)) return;
      iamCall(`/api/iam/users/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !user.disabled }) }, `${user.email} ${user.disabled ? 'enabled' : 'disabled'}.`);
    } else if (button.dataset.iamDelete) {
      if (!confirm(`Remove ${user.email}? They lose access at once.`)) return;
      iamCall(`/api/iam/users/${id}`, { method: 'DELETE' }, `${user.email} removed.`);
    }
  });

  $('iam-matrix').addEventListener('click', (event) => {
    const action = event.target.closest('[data-iam-role-rename], [data-iam-role-copy]');
    if (action) {
      const role = access.data.roles.find((r) => r.id === (action.dataset.iamRoleRename || action.dataset.iamRoleCopy));
      if (role) openRoleForm(action.dataset.iamRoleRename ? 'rename' : 'copy', role);
      return;
    }
    const button = event.target.closest('[data-iam-role-delete]');
    if (!button) return;
    const id = button.dataset.iamRoleDelete;
    if (!confirm(`Remove the role "${roleName(id)}"?`)) return;
    iamCall(`/api/iam/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Role removed.');
  });
}
