# Several Checkmarx One tenants

One CxMissionZero server can serve several Checkmarx One tenants. This is for organisations that run more than one tenant, for example one per region or business unit. Each tenant keeps its own:

- Checkmarx One connection and email server;
- settings, branding and reminder template;
- credit pool, credits and audit log;
- tracked reports and automation;
- people.

It needs a **tenants activation code** from the maintainer of CxMissionZero ([activation codes](activation-codes.md)). The code names your organisation and how many tenants it allows, and lasts 12 months. Without a code, nothing changes: the server serves one tenant, exactly as before.

## Turning it on

1. **Apply the code.** In **Settings → Activation codes**, paste the tenants code and select **Apply the code**.
2. **Switch it on.** **Settings → Tenants** appears once the code is applied. Turn on **Several tenants** there.
3. **Add a tenant.** Type its name (for example *Acme EU*) and select **Add tenant**. Add as many as the code allows. The first tenant, the one you already had, counts as one.
4. **Set the tenant up.** Choose it in the tenant switcher at the top of the page, next to the connection chips. Then, as for a new server:
   - connect its Checkmarx One and email server in **Settings**;
   - add its people under **People & roles**. Everyone you add while working in a tenant works only in that tenant.

To change a tenant's name, use **Rename** in **Settings → Tenants**. **Remove** takes a tenant away: you type its name to confirm, and its people lose access to it at once. Its files are kept in the state folder (`tenants/<id>.removed-<time>`), never deleted.

To turn **Several tenants** off again, remove the other tenants first.

## Who can do what

- **Super Admins** are Admins who work in the first tenant. While the code is in date, they can:
  - turn several tenants on, then add, rename and remove tenants;
  - work in every tenant, using the switcher at the top;
  - choose who works in which tenant (**People & roles → Tenants** on each person).

  The permission is **Super Admin: tenants**. The Admin role holds it.
- **People who work only in other tenants** keep their role's permissions inside their tenants. They never get the ones that act on the whole server: HTTPS, backups, updates, server metrics, troubleshooting logs, activation codes and Super Admin. So an Admin of *Acme EU* runs Acme EU fully, and nothing else.
- **People & roles** shows each tenant's admins only the people who can work in their tenant, including the Super Admins. They cannot change Super Admins. Roles are shared by every tenant, so only people who work in the first tenant change them.
- **People in several tenants** switch between them at the top of the page. Each page then shows the chosen tenant. The switcher is a list: each tenant with its colour (the same everywhere) and when it last loaded findings (or *fetch failed*, or *not loaded*); arrows, Enter and Esc work in it.
- **The consolidated view** (Labs, behind its own activation code): an Admin ticks, person by person, who may see every tenant they work in on one page, read only (**People & roles → May see the consolidated view (all connected tenants)**), whose role also holds See Labs and Labs: Consolidated view. No role holds the tick, not even Admin. It is the first entry of the switcher for them. It shows what each tenant holds (every open finding as last loaded, its credits, its credit pool, Govern's budgets) and, for people who may fetch findings, loads each tenant itself when it is opened, with that tenant's own Checkmarx One connection (from MZ-01.01.14), changes nothing, and each visit is written to each tenant's own audit log. See the [user guide](user-guide.md#labs-consolidated-view).

## What stays separate

- **Settings and connections:** each tenant has its own. The deployment's own options (`CX_API_KEY`, `CX_BASE_URL`, `CX_IAM_URL`, `CX_TENANT`, `SMTP_*` and the like) belong to the first tenant, and only to it (from MZ-01.01.21; see [below](#each-tenant-on-its-own-checkmarx-one)).
- **Checkmarx One data:** a tenant reads only the Checkmarx One its own key connects to. A tenant with no key of its own says it is not connected; it never falls back to another tenant's connection.
- **Emailed reports** act only in the tenant they were sent from. Every link and grant in a report is signed for that tenant, so it cannot be used in another one. Reports sent before several tenants were turned on belong to the first tenant and keep working.
- **Automation, follow-ups and verification** run for each tenant on its own schedule, with its own connection.
- **The audit log:**
  - Each tenant has its own log.
  - Events that concern the whole server go to the first tenant's log: people and sign-ins, backups, updates, HTTPS, activation codes, and adding or removing tenants.
  - When a Super Admin adds a tenant or opens one they were not added to, the event is also written to that tenant's own log, so its admins see it.

## Each tenant on its own Checkmarx One

Connect each tenant under **Settings → Checkmarx One** while working in it, with an API key made in that tenant's Checkmarx One. The key says where it belongs (its issuer: the IAM address and the tenant name), and that is where the tenant connects. Type the API URL, IAM URL or tenant name under **Advanced** only when the key's own are not right (a private deployment, a proxy).

**Fixed in MZ-01.01.21.** Until then, a server started with the first tenant's endpoints in its environment (`CX_BASE_URL`, `CX_IAM_URL`, `CX_TENANT`, as in most `.env` files) applied them to every tenant's key, ahead of what the key itself said. A tenant added later and connected with a key alone was therefore sent to the first tenant's Checkmarx One, and its Workbench, reports and Impact page showed the first tenant's projects and findings. Now those endpoints apply to the first tenant only.

At the first start after the update, CxMissionZero looks once at every tenant added before it:

- A tenant whose key, without the first tenant's endpoints, connects somewhere else read the first tenant's data. What it read is **set aside**, never deleted, in `tenants/<id>/set-aside-<date>/`: its Impact history (`finding-journal.json`), the calculator's read, the initiator addresses it learned, scan attribution and FAE Flush records, and the last read kept in Fusion credits and Primary branches (their rates, plans, allocations, order and choices stay). Sign-ins kept across the restart keep nothing they had loaded there.
- Its audit log says so: *This tenant was connected to the first tenant's Checkmarx One (…); it now connects to its own (…)*.
- What was done through that connection before the update (AI triage, remediation, credit allocations, FAE Flush, reminders) happened in the first tenant's Checkmarx One, and cannot be undone by CxMissionZero. The tenant's audit log names each, with its project.
- Then load the Workbench again in that tenant: it reads its own Checkmarx One.

Each tenant is looked at once (`cxone-origin.json` in its folder records it); a tenant added from MZ-01.01.21 on never needs it.

**Two tenants on one Checkmarx One.** When another tenant on this server is connected to the same Checkmarx One tenant (the same API address and tenant name), **Settings → Checkmarx One** says which, in red, and connecting records it in the audit log. It is allowed (two business units sharing a tenant), but rarely meant.

**How many.** As many tenants as the activation code allows. Thirty tenants, each on its own Checkmarx One, are tested on every change (`test/tenants-connections.e2e.test.js`): each reads only its own, before and after a restart. Each tenant's stores are opened when it is first used, and its connection and automation run on their own, so a further tenant costs its own reads and little else.

## When the code expires

Every tenant keeps working as it is: its people, reports and automation are unaffected. Only the Super Admin tasks wait for a new code: adding, renaming and removing tenants, working in tenants you were not added to, and choosing who works where. **Settings → Activation codes** and **Settings → Tenants** warn 30 days before.

## Backups and storage

- **Backups:** one backup holds every tenant (Audit page → Backups).
- **Restore:** a restore brings back exactly the backup's tenants.
- **Files:** the first tenant keeps the state folder's files as they were. Each further tenant has a folder of its own, `tenants/<id>/`, laid out the same way. The list of tenants is `tenants.json`.
