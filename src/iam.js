/**
 * Who may use this utility, and what each person may do.
 *
 * Users sign in with their email and a password, or with a Checkmarx One API
 * key whose identity (email, username or client id) is mapped to them. Each
 * user has one role; a role is a set of permissions from PERMISSIONS. Three
 * roles are built in:
 *
 *   Admin             everything, including the special permissions: the
 *                     Checkmarx One integration, the email server (SMTP), and
 *                     the utility-wide monthly credit limit (plus backups,
 *                     which carry those secrets)
 *   Security Analyst  everything else, including users and roles
 *   User              fetch findings, send reminders, follow tracked reports
 *
 * Nobody can hand out more than they hold: a user may only assign roles, and
 * build roles, whose permissions are all their own, and may only change users
 * whose role they could have assigned. There is always at least one active
 * Admin. Stored in iam.json in the state folder (and in every backup).
 */

import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export const PERMISSIONS = [
  { id: 'findings.fetch', group: 'Dashboard', label: 'Fetch findings', description: 'Load projects and findings from Checkmarx One.' },
  { id: 'reminders.send', group: 'Dashboard', label: 'Send reminders', description: 'Preview and send reminders, and download HTML reports.' },
  { id: 'initiators.tag', group: 'Dashboard', label: 'Tag initiator addresses', description: 'Give a scan initiator without an address an email address, from the dashboard.' },
  { id: 'reports.view', group: 'Tracked reports', label: 'View tracked reports', description: 'See tracked reports, their progress, and download them.' },
  { id: 'reports.remind', group: 'Tracked reports', label: 'Send follow-ups', description: 'Send a tracked report’s follow-up reminder.' },
  { id: 'reports.manage', group: 'Tracked reports', label: 'Manage tracked reports', description: 'Save, schedule and delete tracked reports.' },
  { id: 'triage.run', group: 'AI & credits', label: 'Run AI Triage & Remediation', description: 'Start AI Triage or Remediation from the dashboard or a tracked report (spends credits).' },
  { id: 'credits.view', group: 'AI & credits', label: 'View credits', description: 'See credit balances and usage.' },
  { id: 'credits.allocate', group: 'AI & credits', label: 'Allocate credits to projects', description: 'Add or remove credits for projects, within the utility-wide limit.' },
  { id: 'credits.limit', group: 'AI & credits', label: 'Set the utility-wide credit limit', description: 'The monthly credit budget for the whole utility.', special: true },
  { id: 'settings.view', group: 'Settings', label: 'View settings', description: 'Open the Settings page read-only. Passwords and keys are never shown.' },
  { id: 'settings.recipients', group: 'Settings', label: 'Recipient list', description: 'Change the default To / Cc / Bcc.' },
  { id: 'settings.initiators', group: 'Settings', label: 'Initiator addresses', description: 'Change how scan initiators are resolved to addresses.' },
  { id: 'settings.template', group: 'Settings', label: 'Email template', description: 'Change the reminder email template.' },
  { id: 'settings.branding', group: 'Settings', label: 'Branding', description: 'Change names, logo and colours.' },
  { id: 'settings.links', group: 'Settings', label: 'Links & server address', description: 'Change links into Checkmarx One and the reminder server address.' },
  { id: 'settings.ai', group: 'Settings', label: 'AI Triage & Remediation rules', description: 'Allow triage and remediation from reports, re-triage, and the administrator contact.' },
  { id: 'settings.automation', group: 'Settings', label: 'Automation', description: 'Change, run and reset automatic reminders.' },
  { id: 'integration.cxone', group: 'Integrations', label: 'Checkmarx One integration', description: 'Connect the server to Checkmarx One (its API key and endpoints).', special: true },
  { id: 'integration.smtp', group: 'Integrations', label: 'Email server (SMTP)', description: 'Configure and test the mail server.', special: true },
  { id: 'audit.view', group: 'Audit & data', label: 'View the audit log', description: 'Browse, verify and reconcile the credit audit log.' },
  { id: 'audit.export', group: 'Audit & data', label: 'Export the audit log', description: 'Download the audit log as CSV or JSON Lines.' },
  { id: 'backup.view', group: 'Audit & data', label: 'View backup status', description: 'See the state folder and backups.' },
  { id: 'backup.run', group: 'Audit & data', label: 'Back up to the folder', description: 'Write a backup into the server’s backup folder.' },
  { id: 'backup.manage', group: 'Audit & data', label: 'Download & restore backups', description: 'Backups hold the SMTP password, API keys and users — so this is an Admin permission.', special: true },
  { id: 'beta.use', group: 'Beta', label: 'Beta features', description: 'Code authors and GitHub identity matching, and their GitHub token.' },
  { id: 'iam.view', group: 'Access', label: 'View users & roles', description: 'See who has access and what each role allows.' },
  { id: 'iam.manage', group: 'Access', label: 'Manage users & roles', description: 'Add, change and remove users and roles — never beyond their own permissions.' },
  { id: 'system.metrics', group: 'Access', label: 'Server load', description: 'See the server’s load and cache figures.' },
];
export const PERMISSION_IDS = PERMISSIONS.map((p) => p.id);
const ADMIN_ONLY = PERMISSIONS.filter((p) => p.special).map((p) => p.id);

export const DEFAULT_ROLES = {
  admin: {
    name: 'Admin',
    description: 'Everything, including the Checkmarx One and email integrations, the utility-wide credit budget, and backups.',
    permissions: PERMISSION_IDS,
    builtin: true,
    locked: true,
  },
  analyst: {
    name: 'Security Analyst',
    description: 'Everything except the Admin-only integrations, credit budget and backups — including users and roles.',
    permissions: PERMISSION_IDS.filter((id) => !ADMIN_ONLY.includes(id)),
    builtin: true,
  },
  user: {
    name: 'User',
    description: 'Fetch findings, send reminders and follow tracked reports. Settings are read-only; users and roles are hidden.',
    permissions: ['findings.fetch', 'reminders.send', 'initiators.tag', 'reports.view', 'reports.remind', 'credits.view', 'settings.view'],
    builtin: true,
  },
};

export const MIN_PASSWORD_LENGTH = 12;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const norm = (value) => String(value ?? '').trim().toLowerCase();

/** A strong temporary password that is easy to read out and type: 4 groups of 5. */
export function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('').match(/.{5}/g).join('-');
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) {
    // Same work either way, so timing does not reveal whether an account exists.
    await scrypt(String(password), 'no-such-user-salt', 32, { N: 16384, r: 8, p: 1 });
    return false;
  }
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

export function passwordProblem(password) {
  const text = String(password ?? '');
  if (text.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (text.length > 256) return 'That password is too long.';
  if (new Set(text).size < 5) return 'That password is too repetitive.';
  return '';
}

export class IamStore {
  #file;
  #state;
  #mtime = 0;

  constructor({ file }) {
    this.#file = file;
    this.#state = this.#load();
  }

  /** Pick up changes another process made (e.g. `node scripts/reset-admin.mjs` on a running server). */
  #fresh() {
    try {
      const mtime = fs.statSync(this.#file).mtimeMs;
      if (mtime !== this.#mtime) this.#state = this.#load();
    } catch {}
  }

  get file() {
    return this.#file;
  }

  #load() {
    let raw = {};
    try {
      this.#mtime = fs.statSync(this.#file).mtimeMs;
      raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {}
    const roles = {};
    for (const [id, role] of Object.entries(DEFAULT_ROLES)) {
      const stored = raw.roles?.[id];
      roles[id] = {
        ...role,
        // Admin always holds every permission, including ones added later.
        permissions: role.locked ? [...PERMISSION_IDS] : validPermissions(stored?.permissions ?? role.permissions),
        description: stored?.description ?? role.description,
      };
    }
    for (const [id, role] of Object.entries(raw.roles ?? {})) {
      if (DEFAULT_ROLES[id]) continue;
      roles[id] = { name: String(role.name ?? id), description: String(role.description ?? ''), permissions: validPermissions(role.permissions), builtin: false };
    }
    const users = Array.isArray(raw.users) ? raw.users.filter((u) => u?.id && u?.email) : [];
    return { version: 1, roles, users };
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
    this.#mtime = fs.statSync(this.#file).mtimeMs;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  hasUsers() {
    this.#fresh();
    return this.#state.users.length > 0;
  }

  roles() {
    this.#fresh();
    return Object.entries(this.#state.roles).map(([id, role]) => ({
      id,
      ...role,
      users: this.#state.users.filter((u) => u.role === id).length,
    }));
  }

  role(id) {
    const role = this.#state.roles[id];
    return role ? { id, ...role } : null;
  }

  users() {
    this.#fresh();
    return this.#state.users.map(publicUser);
  }

  user(id) {
    this.#fresh();
    return this.#state.users.find((u) => u.id === id) ?? null;
  }

  findByEmail(email) {
    this.#fresh();
    const key = norm(email);
    return this.#state.users.find((u) => norm(u.email) === key) ?? null;
  }

  /** The user a Checkmarx One identity belongs to: by email, then by mapped username or client id. */
  findByCxIdentity({ email = '', user = '', clientId = '' } = {}) {
    this.#fresh();
    const keys = [email, user, clientId].map(norm).filter(Boolean);
    if (!keys.length) return null;
    return (
      this.#state.users.find((u) => keys.includes(norm(u.email))) ??
      this.#state.users.find((u) => (u.cxoneIdentities ?? []).some((alias) => keys.includes(norm(alias)))) ??
      null
    );
  }

  /** The permissions a user holds right now (a role change applies at once). */
  permissionsOf(user) {
    if (!user || user.disabled) return new Set();
    return new Set(this.#state.roles[user.role]?.permissions ?? []);
  }

  // -------------------------------------------------------------------------
  // Guard rails
  // -------------------------------------------------------------------------

  /** May someone holding `actorPerms` hand out this role (or build one like it)? */
  canGrant(actorPerms, permissions) {
    return [...permissions].every((p) => actorPerms.has(p));
  }

  #assertCanGrantRole(actorPerms, roleId) {
    const role = this.#state.roles[roleId];
    if (!role) throw fail(400, 'That role does not exist.');
    if (!this.canGrant(actorPerms, role.permissions)) {
      throw fail(403, `You cannot assign "${role.name}": it holds permissions you do not have.`);
    }
  }

  #activeAdmins(except = null) {
    return this.#state.users.filter((u) => u.id !== except && u.role === 'admin' && !u.disabled).length;
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async createUser({ email, name = '', role, password = '', cxoneIdentities = [], mustChangePassword = true }, { actorPerms = null, actorId = '' } = {}) {
    const address = norm(email);
    if (!EMAIL.test(address)) throw fail(400, 'Enter a valid email address.');
    if (this.findByEmail(address)) throw fail(409, `${address} already has access.`);
    if (actorPerms) this.#assertCanGrantRole(actorPerms, role);
    else if (!this.#state.roles[role]) throw fail(400, 'That role does not exist.');
    const aliases = cleanAliases(cxoneIdentities);
    this.#assertAliasesFree(aliases, null);
    if (password) {
      const problem = passwordProblem(password);
      if (problem) throw fail(400, problem);
    }
    const user = {
      id: randomUUID(),
      email: address,
      name: String(name).trim().slice(0, 120),
      role,
      cxoneIdentities: aliases,
      passwordHash: password ? await hashPassword(password) : '',
      mustChangePassword: Boolean(password) && mustChangePassword,
      disabled: false,
      failedLogins: 0,
      lockedUntil: 0,
      createdAt: new Date().toISOString(),
      createdBy: actorId,
      lastLoginAt: '',
    };
    this.#state.users.push(user);
    this.#save();
    return publicUser(user);
  }

  #assertAliasesFree(aliases, userId) {
    for (const alias of aliases) {
      const owner = this.#state.users.find((u) => u.id !== userId && (norm(u.email) === alias || (u.cxoneIdentities ?? []).map(norm).includes(alias)));
      if (owner) throw fail(409, `The Checkmarx One identity "${alias}" already belongs to ${owner.email}.`);
    }
  }

  /** Change a user's name, role, identities or status. Returns {before, after}. */
  updateUser(id, patch, { actorPerms, actorId = '' }) {
    const user = this.user(id);
    if (!user) throw fail(404, 'No such user.');
    if (!this.canGrant(actorPerms, this.permissionsOf({ ...user, disabled: false }))) {
      throw fail(403, `You cannot change ${user.email}: their role holds permissions you do not have.`);
    }
    const before = publicUser(user);
    const next = { ...user };
    if ('name' in patch) next.name = String(patch.name ?? '').trim().slice(0, 120);
    if ('role' in patch && patch.role !== user.role) {
      this.#assertCanGrantRole(actorPerms, patch.role);
      if (id === actorId) throw fail(400, 'You cannot change your own role.');
      next.role = patch.role;
    }
    if ('cxoneIdentities' in patch) {
      next.cxoneIdentities = cleanAliases(patch.cxoneIdentities);
      this.#assertAliasesFree(next.cxoneIdentities, id);
    }
    if ('disabled' in patch) {
      if (patch.disabled && id === actorId) throw fail(400, 'You cannot disable yourself.');
      next.disabled = patch.disabled === true;
      if (!next.disabled) {
        next.failedLogins = 0;
        next.lockedUntil = 0;
      }
    }
    if (user.role === 'admin' && !user.disabled && (next.role !== 'admin' || next.disabled) && this.#activeAdmins(id) === 0) {
      throw fail(400, 'There must always be at least one active Admin.');
    }
    Object.assign(user, next);
    this.#save();
    return { before, after: publicUser(user) };
  }

  deleteUser(id, { actorPerms, actorId = '' }) {
    const user = this.user(id);
    if (!user) throw fail(404, 'No such user.');
    if (id === actorId) throw fail(400, 'You cannot remove yourself.');
    if (!this.canGrant(actorPerms, this.permissionsOf({ ...user, disabled: false }))) {
      throw fail(403, `You cannot remove ${user.email}: their role holds permissions you do not have.`);
    }
    if (user.role === 'admin' && !user.disabled && this.#activeAdmins(id) === 0) {
      throw fail(400, 'There must always be at least one active Admin.');
    }
    this.#state.users = this.#state.users.filter((u) => u.id !== id);
    this.#save();
    return publicUser(user);
  }

  /** Set a password. An administrator's reset makes the user choose a new one at next sign-in. */
  async setPassword(id, password, { mustChange = false, actorPerms = null } = {}) {
    const user = this.user(id);
    if (!user) throw fail(404, 'No such user.');
    if (actorPerms && !this.canGrant(actorPerms, this.permissionsOf({ ...user, disabled: false }))) {
      throw fail(403, `You cannot reset ${user.email}'s password: their role holds permissions you do not have.`);
    }
    const problem = passwordProblem(password);
    if (problem) throw fail(400, problem);
    user.passwordHash = await hashPassword(password);
    user.mustChangePassword = mustChange;
    user.failedLogins = 0;
    user.lockedUntil = 0;
    this.#save();
    return publicUser(user);
  }

  /**
   * Check an email and password. Returns the user, or throws 401 (same message
   * whether the account exists or not) / 423 when locked after repeated failures.
   */
  async signIn(email, password, now = Date.now()) {
    const user = this.findByEmail(email);
    const ok = await checkPassword(password, user?.passwordHash);
    if (!user || !user.passwordHash) throw fail(401, 'Wrong email or password.');
    if (user.lockedUntil > now) {
      throw fail(423, `Too many failed attempts: try again after ${new Date(user.lockedUntil).toLocaleTimeString()}, or ask an administrator.`, { userId: user.id });
    }
    if (!ok) {
      user.failedLogins = (user.failedLogins ?? 0) + 1;
      if (user.failedLogins >= MAX_FAILED) {
        user.lockedUntil = now + LOCK_MS;
        user.failedLogins = 0;
      }
      this.#save();
      throw fail(401, 'Wrong email or password.', { userId: user.id, locked: user.lockedUntil > now });
    }
    if (user.disabled) throw fail(403, 'This account is disabled. Ask an administrator.', { userId: user.id });
    this.recordSignIn(user, now);
    return user;
  }

  recordSignIn(user, now = Date.now()) {
    user.failedLogins = 0;
    user.lockedUntil = 0;
    user.lastLoginAt = new Date(now).toISOString();
    this.#save();
  }

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  /** Create (no id) or change a role. Returns {before, after}. */
  saveRole(id, { name, description = '', permissions }, { actorPerms }) {
    const existing = id ? this.#state.roles[id] : null;
    if (id && !existing) throw fail(404, 'No such role.');
    if (existing?.locked) throw fail(400, `${existing.name} always holds every permission and cannot be changed.`);
    const perms = validPermissions(permissions);
    if (!this.canGrant(actorPerms, perms)) throw fail(403, 'A role cannot hold permissions you do not have yourself.');
    if (existing && !this.canGrant(actorPerms, existing.permissions)) {
      throw fail(403, `You cannot change "${existing.name}": it holds permissions you do not have.`);
    }
    const label = String(name ?? existing?.name ?? '').trim().slice(0, 60);
    if (!label) throw fail(400, 'Give the role a name.');
    if (Object.entries(this.#state.roles).some(([rid, r]) => rid !== id && norm(r.name) === norm(label))) {
      throw fail(409, `A role called "${label}" already exists.`);
    }
    const roleId = id || `role-${randomUUID().slice(0, 8)}`;
    const before = existing ? { id: roleId, ...existing } : null;
    this.#state.roles[roleId] = {
      ...(existing ?? { builtin: false }),
      name: existing?.builtin ? existing.name : label,
      description: String(description ?? '').trim().slice(0, 300),
      permissions: perms,
    };
    this.#save();
    return { before, after: { id: roleId, ...this.#state.roles[roleId] } };
  }

  deleteRole(id, { actorPerms }) {
    const role = this.#state.roles[id];
    if (!role) throw fail(404, 'No such role.');
    if (role.builtin) throw fail(400, `${role.name} is built in and cannot be removed.`);
    if (!this.canGrant(actorPerms, role.permissions)) throw fail(403, `You cannot remove "${role.name}": it holds permissions you do not have.`);
    const holders = this.#state.users.filter((u) => u.role === id).length;
    if (holders) throw fail(400, `${holders} user(s) still have "${role.name}". Give them another role first.`);
    delete this.#state.roles[id];
    this.#save();
    return { id, ...role };
  }
}

function validPermissions(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((p) => PERMISSION_IDS.includes(p)))];
}

function cleanAliases(list) {
  const values = Array.isArray(list) ? list : String(list ?? '').split(/[\n,]+/);
  return [...new Set(values.map(norm).filter(Boolean))].slice(0, 20);
}

/** A user as the browser may see them: never the password hash. */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? '',
    role: user.role,
    cxoneIdentities: user.cxoneIdentities ?? [],
    hasPassword: Boolean(user.passwordHash),
    mustChangePassword: Boolean(user.mustChangePassword),
    disabled: Boolean(user.disabled),
    locked: (user.lockedUntil ?? 0) > Date.now(),
    createdAt: user.createdAt ?? '',
    lastLoginAt: user.lastLoginAt ?? '',
  };
}
