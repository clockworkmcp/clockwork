# Jira

Brings updates to the Jira Cloud issues that involve you into Clockwork: issues you are assigned to, reported or watch.
Each time such an issue changes, you get one item saying what happened: the text of a new comment, which fields changed
(for example the status), or that the issue was created, with who did it and a link to the issue. Your own updates are
left out.

It only reads. It never comments, moves an issue to another status, assigns, watches or edits anything.

## Set it up

1. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>. Two kinds work:
   - **"Create API token with scopes"** (better): choose Jira and only the reading scopes `read:jira-work` and
     `read:jira-user`. A token like this cannot change anything. It needs your site's cloud id as well: open
     `https://yourname.atlassian.net/_edge/tenant_info` in your browser while signed in and copy the `cloudId`.
   - **"Create API token"** (simpler): works with the site address alone, but the token can do everything your account
     can. This extractor still only reads, but the token itself is not limited.
2. Save a file named `login.json` in this extractor's private folder (`~/.clockwork/v2/extractor-data/jira/login.json`
   unless you moved Clockwork's data; `clockwork connect jira` tells you the exact place if the file is missing):

   ```json
   {
     "site": "https://yourname.atlassian.net",
     "email": "you@example.com",
     "apiToken": "paste the token here",
     "cloudId": "only for a token with scopes"
   }
   ```

   `email` is the address of the Atlassian account that created the token. Leave `cloudId` out for a plain token.
3. Run `clockwork check jira`, then `clockwork enable jira`.

Tokens expire (after a year at most). When that happens Clockwork shows this source as needing a login: create a new
token and put it in the file.

### Choosing which issues

By default it searches for `assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()`, limited to
issues updated since the last look. To use your own search instead, add a `"jql"` line with just the condition (no
`ORDER BY`), for example `"jql": "project = ABC AND watcher = currentUser()"`.

**Mentions.** Jira has no official search for "issues where I am mentioned". People report that
`comment ~ currentUser()` finds issues where you are mentioned in a comment, but not reliably, and it is not in
Atlassian's documentation, so it is not in the default. You can try it: `"jql": "assignee = currentUser() OR reporter =
currentUser() OR watcher = currentUser() OR comment ~ currentUser()"`. In practice Jira usually makes you a watcher of an
issue when you comment on it, and many sites add people who are mentioned as watchers, so the default catches most of it.

## Permission needed

Read access to the issues you can already see. With a scoped token: `read:jira-work` and `read:jira-user`.

## What it contacts

- Your Jira site (the `site` address, for example `https://yourname.atlassian.net`), or `https://api.atlassian.com`
  when you use a token with scopes. Three kinds of request, all of them reads: who you are, the search, and the latest
  comment of an updated issue.
- Clockwork on this machine (`127.0.0.1`), to hand over the items.

Nothing else. The site address must start with `https://`.

## What it stores, and where

In its private folder only:

- `login.json`: what you saved, including the token.
- `state.json`: when it last looked, and for each recently updated issue its key and the time of its last update, so
  nothing is brought in twice. No issue text.

The items themselves (issue key and title, status, who, comment text) go into Clockwork's own store on this machine.

## Limits

- It searches every two minutes, with a pause before each request, and waits when Jira says to slow down.
- The first run brings in issues updated in the last 24 hours, marked as history. After that, only what is new. If it
  was off for more than a week, it looks back one week.
- One item per issue per look: if an issue got three comments between two looks, you get the newest one.
- It works out what happened from the issue's latest change and latest comment. When it cannot tell (for example an
  attachment was added), the item just says the issue was updated, with no name.
- A comment restricted to a group you are not in is not visible to you in Jira, so it is not visible here either.
- Jira's search can be a few seconds behind, so an update can take one extra look to arrive.
- Jira Cloud only. Jira Data Center and Server are not covered.

## The risk

This is almost always a work account. Issue titles and comments are your employer's information, and this copies them to
this machine and shows them to your agent. Whether that is allowed is your employer's decision, not yours and not
Clockwork's. Ask first if you are not sure. To stop, run `clockwork disable jira`, delete `login.json`, and revoke the
token on the page where you created it.
