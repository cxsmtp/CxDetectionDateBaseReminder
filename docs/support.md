# Get help: support cases and enhancements

Anyone signed in can ask for help or for something new, get a number by email, and follow it until it is done. The support team answers in the same place.

## Asking

Point at **Get help** at the bottom of the sidebar, or click it. On a phone, use **Get help** in the user menu. Two choices open:

- **Submit a support case.** Use it when something does not work, or you are stuck. Give a short title, describe what happened, and set a priority: Low, Normal, High, or Urgent when work is blocked. Cases are numbered SUP-0001, SUP-0002 and so on.
- **Request an enhancement.** Use it for a new feature or an improvement. Enhancements have their own numbers: ENH-0001, ENH-0002 and so on.

Below them, **Track my requests** opens the **Get help** page.

As soon as you submit, the page shows your number, and you get an email with it and a link to follow the request.

## Following a request

The **Get help** page lists your requests, newest first. Filter them by type and by status. **Open** shows everything not yet completed or declined.

Open a request to see its conversation, its status, and the history of status changes. Add to it at any time: the support team gets an email. When the team answers or changes the status, you get an email too, and each email links straight to the request.

| Status | Meaning |
| --- | --- |
| New | Raised, not picked up yet |
| In progress | The team is working on it |
| Waiting for reply | The team needs something from you. Answering sends it back to them as In progress |
| Completed | Done. For an enhancement, it is built |
| Declined | Will not be done. The conversation says why |

Answering a completed or declined request reopens it as New.

## The support team

People whose role has **Answer support cases & enhancements** (`support.manage`) are the support team:

- **What they see.** The **Get help** page shows them the **Support queue**: every request raised in the Checkmarx One tenants they work in. A Super Admin works in every tenant, so sees every request. **Mine** narrows the queue to their own requests.
- **What they hear.** Each of them gets an email for every new request in those tenants, and whenever the person who raised a request writes again.
- **What they do.** They answer in the conversation, and move the request on with **Status → Update status**. The person who raised it gets an email with every change.

The Admin role holds this permission. Give it to others under **People & roles**.

Everyone else sees only their own requests. Opening anyone else's request answers "No such request", whether or not it exists.

## Email

Emails go through the mail server of the tenant the request was raised in (**Settings → Email**). The link in each email uses the reminder server address (**Settings → Links**).

If the mail server is not set up or not tested, the request is still saved and numbered. The page then says that the email could not be sent, and why.

## Limits and storage

- **Size.** A title can be up to 200 characters, and each message up to 10,000.
- **Rate.** One person can raise up to 20 requests an hour.
- **Storage.** Requests are kept in `support.json` in the state folder, which is included in every backup.
