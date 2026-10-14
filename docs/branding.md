# Branding, and your own branding for demonstrations

CxMissionZero has two kinds of branding.

- **The organisation's branding** is under Settings → Branding. It is the app name, company name, logo, accent colour and call to action that everyone uses, and that head every reminder email and report.
- **Your branding** is under Settings → Your branding. It is one person's own names, logo and colours, for when they present CxMissionZero to someone else, such as a prospect, a customer or another team.

## The look of the app: next-gen or classic

MZ-01.00.77 adds a **next-gen look**: glass panels on a deep "Obsidian" dark or a soft "Daylight" light, a gradient brand mark and primary buttons, Plus Jakarta Sans for text and JetBrains Mono for figures, chips and table headers. The **classic look** is the look before it, unchanged. Both work light, dark or on the device's setting, in every language (Arabic and Hebrew right to left), and on a phone.

**Each person** chooses with the palette button next to their name: **Look** (Next-gen or Classic), **Theme** (Auto, Light, Dark) and **Accent** (indigo, cyan, emerald, violet or amber). It is saved to their profile (quietly: no audit entry), so it follows them to every computer, and it is applied before the page appears, with no flash.

**The reports they download** are in their look: the interactive HTML report (next-gen header, glass cards, their accent; their theme chosen, or their device's on Auto), and the Cx Credits Calculator's projection report and PDF summary. A report emailed to someone, or run on a schedule, is in that person's look when they have an account, otherwise in the organisation's default. Printing always uses a light page.

**An Admin** (or a role with **Branding**) decides for everyone under Settings → Branding → **Look of the app**:

| Setting | Default | What it does |
| --- | --- | --- |
| **Offer the next-gen look** | On | Off: everyone has the classic look, every report is classic, and the look menu offers only the theme. Turning it back on gives everyone the next-gen look again, except those who chose Classic. |
| **Menu in the next-gen look** | Down the left side | **Along the top**: the pages in one row across the top, on screens 1261 pixels wide and more (names only below 1600 pixels). Narrower screens keep the side menu, the icon rail or the phone's bottom bar. |

Both change for everyone as soon as they are saved. A person's own branding cannot change them.

The fonts are inside the image (`public/fonts`, SIL Open Font License 1.1, see `public/fonts/OFL.txt`). Nothing is loaded from the internet, so the next-gen look works on a server with no internet access. The report files do not carry the fonts (they travel by email): a reader who has Plus Jakarta Sans or JetBrains Mono installed sees them, everyone else their system's own.

## Your branding

Open your name at the top right, then **Settings**, then **Your branding**. It sits under **You**, next to **Your profile**.

1. Turn on **Use my branding**.
2. Fill in what should change: the app name, company name, logo (an `https` address, or upload a PNG, JPG, SVG or WebP up to 200 KB), logo height, accent colour and call to action. A field left empty keeps the organisation's value, which is shown in grey in the box.
3. The preview shows the head of a reminder or report as it will look.

Changes save as you type. While it is on:

- **This app** shows you your app name and logo in the sidebar and the browser tab title.
- **The reports you download** and **the reminders you send** carry your branding. That includes reminders from a tracked report you send yourself, the impact summary you download, and the code-author emails you send.
- **Everyone else** still sees and sends the organisation's branding.
- **Scheduled runs** always use the organisation's branding: automation, follow-ups on a schedule and the monthly impact summary. So does **Run now** under Automation.
- **Get help** emails always use the organisation's name.

Turn **Use my branding** off to go back to the organisation's. What you typed is kept for next time. **Clear my branding** empties every field.

Each change is in the audit log (type **Access change**). An uploaded logo is recorded only as "(uploaded image)".

## Who may do what

Three new permissions, and the existing **Branding**, under **People & roles → Roles & permissions** (group **Settings**):

| Permission | What it allows | Admin | Security Analyst | User |
| --- | --- | --- | --- | --- |
| **See the Branding page** | Open Settings → Branding, read-only without **Branding**. | ✓ | ✓ on new installations | – |
| **Branding** | Change the organisation's branding. | ✓ | ✓ | – |
| **Their own branding** | Settings → Your branding. | ✓ | ✓ on new installations | – |
| **See the Activation codes page** | Open Settings → Activation codes read-only: what is unlocked, and until when. Entering codes and choosing who may use Hebrew still needs **Activation codes**. | ✓ | – (an Admin can give it) | – |

On a server that was running before MZ-01.00.54, the roles keep the permissions they had. Admin holds every permission. To give Security Analysts the new ones, tick them for that role.

The Branding page was open to everyone with **View settings** until MZ-01.00.54. Now it needs **See the Branding page** or **Branding**.

## Seeing only your level and below

On **People & roles**, each person sees only the people and roles within their own permissions:

- An **Admin** sees everyone.
- A **Security Analyst** sees Security Analysts, Users, and any role whose permissions they all hold. They do not see who the Admins are, or the Admin role.
- Someone added in one tenant does not see the Super Admin.

Opening a hidden person by address answers "No such user." This applies to their picture too, and to the people listed on Activation codes.

To move someone down to Security Analyst, an Admin changes their role on **People & roles**. From then on they see only Security Analysts and below.
