# GitLab to-do items

Brings your pending GitLab to-do items into Clockwork: mentions, assignments, review requests, failed pipelines, approvals
and the rest of your To-Do List. One item per to-do; to-dos about the same issue or merge request share a thread.

It only reads. It never marks a to-do as done, never comments, never changes anything on GitLab.

## Setting it up

1. On GitLab: select your avatar, **Edit profile**, **Access**, **Personal access tokens**, and create a token. If GitLab
   offers a choice, pick the ordinary ("legacy") kind.
2. Give it a name, pick an expiry date, and tick **only** the `read_api` scope.
3. If your GitLab is not gitlab.com, save its address, for example `https://gitlab.example.com`, as the only line of
   `~/.clockwork/v2/extractor-data/gitlab/host`. It must start with `https://`.
4. Copy the token (it starts with `glpat-`). Run `clockwork connect gitlab` in your own terminal and paste it when asked;
   nothing is shown as you paste. Clockwork keeps it in your macOS Keychain, not in a file (on a machine with no
   keychain, in a file only you can read).
5. `clockwork check gitlab`.

**The permission.** `read_api` lets the token read through GitLab's API and change nothing. It does reach more than the
To-Do List: it can read whatever you can read on that GitLab. GitLab has no narrower scope that covers to-dos.

## What an item looks like

- Channel: the project, for example `acme/widgets`.
- Text: the action in square brackets, what it is about, then what was said:
  `[mentioned] Merge request !7: Add a retry to the uploader`, a blank line, and the comment.
- Author: whoever caused the to-do. Link: the issue, merge request or comment on GitLab.

## What it contacts

- `gitlab.com` (or the server in `host`), with one kind of request only: `GET /api/v4/todos?state=pending`.
- Clockwork on this machine.

Nothing else.

## What it keeps

In its private folder: the optional `host`, and `state.json` with the numbers and times of the to-dos it has
already sent. No to-do text is kept there.

## Limits

- The first run brings everything that is pending now, however old, marked as history. After that only new or updated
  to-dos.
- A to-do you tick off on GitLab stays in Clockwork; items are never removed.
- It looks every two minutes and waits when GitLab says it is being asked too often.
- Up to 1,000 pending to-dos are read per look. Text is cut at 4,000 characters.
- Only to-dos. Notification e-mails and activity that GitLab does not turn into a to-do are not seen.

## Risks

- The token can read everything you can read on that GitLab. Anyone who gets hold of it can do the same. Give
  it an expiry date and revoke it on GitLab when you stop using this.
- A work account belongs to your employer. Whether you may create a token and bring your to-dos into a tool on your own
  machine is their decision; some GitLab servers do not allow personal tokens at all.
- Titles and comments of private work can end up in Clockwork's store on this machine and be shown to your agent.
