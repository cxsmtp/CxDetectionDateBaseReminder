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
- **People in several tenants** switch between them at the top of the page. Each page then shows the chosen tenant.

## What stays separate

- **Settings and connections:** each tenant has its own. The deployment's own options (`CX_API_KEY`, `SMTP_*` and the like) belong to the first tenant.
- **Emailed reports** act only in the tenant they were sent from. Every link and grant in a report is signed for that tenant, so it cannot be used in another one. Reports sent before several tenants were turned on belong to the first tenant and keep working.
- **Automation, follow-ups and verification** run for each tenant on its own schedule, with its own connection.
- **The audit log:**
  - Each tenant has its own log.
  - Events that concern the whole server go to the first tenant's log: people and sign-ins, backups, updates, HTTPS, activation codes, and adding or removing tenants.
  - When a Super Admin adds a tenant or opens one they were not added to, the event is also written to that tenant's own log, so its admins see it.

## When the code expires

Every tenant keeps working as it is: its people, reports and automation are unaffected. Only the Super Admin tasks wait for a new code: adding, renaming and removing tenants, working in tenants you were not added to, and choosing who works where. **Settings → Activation codes** and **Settings → Tenants** warn 30 days before.

## Backups and storage

- **Backups:** one backup holds every tenant (Audit page → Backups).
- **Restore:** a restore brings back exactly the backup's tenants.
- **Files:** the first tenant keeps the state folder's files as they were. Each further tenant has a folder of its own, `tenants/<id>/`, laid out the same way. The list of tenants is `tenants.json`.
