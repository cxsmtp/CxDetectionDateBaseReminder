# Hands-off mode and self-healing

Some teams don't want one more tool to look after. For them, MissionZero can be set up once and then left alone. It works in the background, sends a short status each week, takes requests from that email, and looks after itself. Nobody has to sign in.

## Set it up once

Open **Settings → Hands-off** (under **Start**). You need the **Automation** permission; Admins have it. The page first shows whether Checkmarx One is connected, the email server is tested, and the server address is set. The server address is what makes the email buttons work. Then answer four questions:

1. **What should MissionZero do on its own?**
   - **Remind developers about their ageing findings.** These are the same automatic reminders as Settings → Automation.
   - **Email a short status every week.**
   - **Email leadership the monthly impact summary.** This needs the **AI Triage & Remediation rules** permission.
2. **Which findings?** Choose the severities, and how old a finding must be before its first reminder, for example 30, 60, 90 days.
3. **Who?** Choose where reminders go: each developer, the fixed list, or both. Then say who gets the weekly status and who gets the monthly summary.
4. **When?** Choose how often MissionZero checks and reminds: every 6 hours, every day or every week. Then choose the day and hour of the weekly status, in the server's time.

Select **Turn on hands-off**. **Send the status now** sends one straight away. **Turn off hands-off** stops the automatic reminders and the weekly status; the self-check keeps running.

## Steer it by email

The weekly status gives:

- the reminders sent;
- what was fixed, with and without AI;
- what AI showed was not exploitable;
- the security debt and when it reaches zero at this pace;
- the next reminder run;
- the health of the server.

It has buttons:

| Button | What it does |
| --- | --- |
| **Send the reminders now** | Runs the automatic reminders now. |
| **Pause for 7 days** / **Resume** | Stops the automatic reminders, the scheduled follow-ups of tracked reports and the weekly status until then, or starts them again. |
| **Stop sending me this** | Takes you off the status list. |

Each button opens a page that asks once more ("Yes, do it"). A mail scanner that opens every link in an email therefore never changes anything. Each button works for the person it was sent to, for 30 days, and only if that person is still on the status list or an administrator. A changed or expired link does nothing.

**Replies.** Tick **Also read replies** and MissionZero reads the mailbox it sends from, using the email server's account over IMAP. The mailbox server defaults to the email server's host, on port 993. A reply acts when it starts with one word:

| Word | What it does |
| --- | --- |
| `PAUSE` (or `PAUSE 14`) | Pause for 7 days (or the number of days given, up to 90). |
| `RESUME` | Resume after a pause. |
| `RUN` | Send the reminders that are due now. |
| `STATUS` | Email me the status now. |
| `STOP` | Stop sending me the status. |
| `SOLVED` | Close the support case the email is about (administrators). |

MissionZero only acts on a reply that is safe to act on:

- **From the right address.** The reply comes from the address the email was sent to. The subject carries a short reference made from that address (`[MZR-…]`), so a reply from anyone else, even with the same subject, is ignored.
- **The person's own words.** Only the first line above the quoted message counts.
- **Never an automatic message.** Auto-replies, out-of-office messages and bounces are never answered, so mail cannot loop.

MissionZero only reads unread mail, marks it read, keeps only the sender, the subject and the text, and never opens attachments. It answers each request with one line saying what it did. Every request is in the audit log.

## It looks after itself

Every 5 minutes the server checks itself:

| Check | How |
| --- | --- |
| **Checkmarx One** | It asks Checkmarx One one small question with the server's key. |
| **Email server** | It connects and signs in, but sends nothing. |
| **Automatic reminders** | It looks at whether the last two runs failed. |
| **Errors** | It counts errors on the server: more than 30 in 15 minutes is a problem. |

**What it puts right on its own** (each repair is tried once while a problem lasts):

| Repair | When |
| --- | --- |
| **Put back the last working connection** | A changed Checkmarx One or email connection does not work. |
| **Sign in to Checkmarx One again** | The connection or the automatic runs fail. |
| **Try the mail server again after a pause** | The mail server fails. |
| **Go back to the previous version** | A version that came in less than a day ago broke what worked before, and the version before it passed a whole check. This happens once per version, and only when the server runs under its launcher (the image's own start command). |

**Who it tells.** Administrators are the people who may update the server or connect Checkmarx One or the email server, in the tenant concerned.

| When | Email |
| --- | --- |
| A problem is seen on two checks in a row | **MissionZero needs attention** |
| A repair fixes a problem it had told you about | **MissionZero fixed itself** |
| The problem clears | **MissionZero is working again** |
| It goes back to the previous version | **MissionZero went back to MZ-…** |

When the email server itself is the problem, these emails cannot go out. The page shows the problem anyway.

**A support case, raised by itself.** This happens when all of the following are true:

- the problem lasts three checks;
- **auto-update** is on (Settings → Update & recovery);
- the last update check reached the internet.

MissionZero then raises a support case (SUP-…, under **Get help**, from **MissionZero (automatic)**). It emails the administrators asking them to forward the email to the maintainer, `MAINTAINER_EMAIL`, by default bhawani.singh@checkmarx.com. MissionZero never sends anything outside your network by itself.

The email carries the troubleshooting log: no personal data, keys or findings. To close the case, use **Mark as solved**, or reply `SOLVED`. One case is raised per problem while it lasts. When the problem clears, the case says so, and stays open until an administrator closes it.

**Errors that escape.** An error the code did not catch is recorded in the troubleshooting log, and the server keeps serving. Under the launcher, an uncaught exception restarts the server; the launcher already restarts a crash with a growing pause, and rolls back a version that does not start.

The **Self-check** box on Settings → Hands-off shows what is wrong now, when the last check ran, and the last events. **Check now** runs a check straight away.

## Settings

| Setting | Where | Default |
| --- | --- | --- |
| Weekly status: who, day, hour | Settings → Hands-off | Nobody; Monday 08:00 |
| Read replies, mailbox server and port | Settings → Hands-off | Off; the email server's host, 993 |
| Where automatic cases are forwarded | `MAINTAINER_EMAIL` | bhawani.singh@checkmarx.com |
| How often the self-check runs | `WATCHDOG_EVERY_SECONDS` | 300 |
| How often replies are read | `INBOX_EVERY_SECONDS` | 120 |

The self-check's state is kept in `watchdog.json` in the state folder, which is in every backup.
