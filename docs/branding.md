# Branding, and your own branding for demonstrations

CxMissionZero has two kinds of branding.

- **The organisation's branding** is under Settings → Branding. It is the app name, company name, logo, accent colour and call to action that everyone uses, and that head every reminder email and report.
- **Your appearance** is under Settings → Your appearance: each person's own look, theme, accent and explanations. It changes how the app looks to that person only; the organisation's look, whether people may choose their own, and where the menu sits stay with the Admin below.
- **Your branding** is under Settings → Your branding. It is one person's own names, logo and colours, for when they present CxMissionZero to someone else, such as a prospect, a customer or another team.

## The look of the app: nine looks to choose from

Every look is kept, so an organisation, and each person, can choose (MZ-01.00.83). All of them work light, dark or on the device's setting, in every language (Arabic and Hebrew right to left), and on a phone.

| Look | What it is like |
| --- | --- |
| **Command center** (the base look, and the default) | Calm and made by hand: warm paper on light, night ink on dark, a dark menu console, hairlines, headings and figures in Fraunces. |
| **Cabin** | A luxury car's cockpit at night: glass panes, a fine line of ambient light along the top and down the menu in the accent colour (it sweeps in as the page opens), and the Dashboard's findings glowing like the points of light on a dial. |
| **Circuit** | A sports car's instrument cluster: graphite, condensed capitals, and on the Dashboard a tachometer whose needle points at the share actioned, with a red line. |
| **Residence** | A grand hotel: ivory paper, deep navy, a touch of gold, and a serif for what is read first. |
| **Chronometer** | A fine watch: deep green and gold, a sunburst dial, a fluted bezel round the Dashboard's findings and the share actioned in a date window. |
| **Signal** | Paper and ink with one vivid signal colour, soft rounded shapes and space instead of boxes. |
| **Studio** | Bright and airy, with a confident violet. |
| **Atelier** | Warm paper and a watchmaker's taupe, hairlines and a serif. |
| **Classic** | The look before MZ-01.00.77, unchanged. |

The looks only borrow a feeling from the things they are named after; they carry no maker's name or mark. In every look but Classic, buttons stand a little off the page (lit from above, rising under the pointer, pressing in when clicked); the **golden buttons** ("Triage / Remediate with AI Assist now", and Credit Control's "Use the credits") keep their own gold in every look.

**Each person** chooses under Settings → **Your appearance**: **Look** (the organisation's, or any of the nine, when the organisation lets people choose), **Theme** (Auto, Light, Dark), **Accent** (Ink, Lagoon, Sage, Plum or Ochre; in Cabin it is the colour of the ambient light, in Circuit and Signal the colour of the signal) and **Explanations** (behind a **?**, or shown). Look, theme and accent are saved to their profile (quietly: no audit entry), so they follow them to every computer, and they are applied before the page appears, with no flash; explanations are kept in that browser. An Admin can also set a person's look under People & roles → their profile.

**The reports they download** are in their look: the interactive HTML report (the console's ink behind the header, paper or night cards, their accent; their theme chosen, or their device's on Auto), and the Cx Credits Calculator's projection report and PDF summary. Every look but Classic gives the report the command-center style. A report emailed to someone, or run on a schedule, is in that person's look when they have an account, otherwise in the organisation's. Printing always uses a light page.

**An Admin** (or a role with **Branding**) decides for everyone under Settings → Branding → **Look of the app**:

| Setting | Default | What it does |
| --- | --- | --- |
| **The organisation's look** (the picture cards) | Command center | Everyone's look, unless they pick their own. |
| **Let people choose their own look** | On | Off: everyone has the organisation's look, and Settings → Your appearance offers only the theme, accent and explanations. A person's own choice is kept, and comes back if this is turned on again. |
| **Menu in the new looks** | Down the left side | **Along the top**: the pages in one row across the top, on screens 1261 pixels wide and more (names only below 1600 pixels). Narrower screens keep the side menu, the icon rail or the phone's bottom bar. |

They change for everyone as soon as they are saved. A person's own branding cannot change them. A server that had the command-center look turned off before MZ-01.00.83 has Classic for everyone, with no choice, as before; the settings API still accepts and returns `nextGen` (false only when everyone has Classic).

## The menu: pinned pages, Focus, fold every group

Point at a page in the menu and click its pin to keep it at the top, under **Pinned**. **Focus**, at the top of the menu, shows only the pinned pages (and the page open); click it again for every page. The button beside it folds or unfolds every group at once; a group's own name still folds just that group. Pins, Focus and folds are kept in that browser. On a narrow screen (the icon rail and the phone's bottom bar), and with the menu along the top, the menu shows every page as before.

## Fonts

The fonts are inside the image (`public/fonts`: Fraunces and IBM Plex, SIL Open Font License 1.1, see `public/fonts/OFL.txt`). Nothing is loaded from the internet, so every look works on a server with no internet access. The report files do not carry the fonts (they travel by email): a reader who has Fraunces or IBM Plex installed sees them, everyone else Palatino or Georgia for headings and their system's own sans for text.

### Your own brand font (Founders Grotesk for Checkmarx)

An organisation can use its own licensed brand font in place of IBM Plex Sans. Its files are **never** part of this repository or the image (both are public): the organisation puts its own copies in a folder on the server, and only its installation serves them, to its own users.

- Put the font files in `fonts` inside the data folder (`/data/fonts` in the container), or point `BRAND_FONT_DIR` at another folder. WOFF2, WOFF, OTF and TTF are read; the weight and style come from the file names (`FoundersGrotesk-Light.otf`, `FoundersGrotesk-SemiboldItalic.woff2`); condensed cuts (`…Cond…`, `…XCond…`) become their own families. The folder is read again within a minute of a change; no restart is needed.
- `BRAND_FONT_FAMILY` is the font's installed name (default `Founders Grotesk`): a computer with the font installed uses it even when the server has no files.
- Check your licence: serving font files to browsers usually needs the foundry's **web** licence; a desktop licence covers only the computers it is installed on (which then use it through the installed copy, with no files on the server).

Windows cmd, with the fonts in `C:\mz\fonts`:

```
podman run -d --name mission-zero -p 3000:3000 -v mission-zero-data:/data -v C:\mz\fonts:/data/fonts:ro ghcr.io/cxsmtp/cxdetectiondatebasereminder:latest
```

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
