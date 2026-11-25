# GitHub notifications

Brings your GitHub notifications into Clockwork: mentions, review requests, assignments, failed workflow runs, security
alerts and the rest of what GitHub puts in your inbox. One item per notification; when a thread gets something new, a new
item arrives in the same thread.

It only reads. It never marks a notification as read or done, never comments, never changes a subscription. Reading the
list through the API leaves your GitHub inbox exactly as it was.

## Setting it up

1. On GitHub: **Settings**, **Developer settings**, **Personal access tokens**, **Tokens (classic)**, then
   **Generate new token (classic)**.
2. Give it a name, pick an expiry date, and tick **only** the `notifications` box. Leave everything else unticked.
3. Copy the token (it starts with `ghp_`). Run `clockwork connect github` in your own terminal and paste it when asked;
   nothing is shown as you paste. Clockwork keeps it in your macOS Keychain, not in a file (on a machine with
   no keychain, in a file only you can read).
4. `clockwork check github`.

**Why a classic token.** GitHub's documentation for the notifications API says it only accepts classic personal access
tokens, with the `notifications` or `repo` scope. The newer fine-grained tokens are not accepted, and the notifications
calls are not in GitHub's list of what fine-grained tokens can reach. `notifications` is the narrowest choice that works.
Be aware that GitHub describes this scope as covering both reading notifications and marking them as read; this program
only ever reads. Do not use `repo`: it gives full read and write access to all your repositories.

**GitHub Enterprise.** Save the API address of your server, for example `https://github.example.com/api/v3`, in a file
named `api` next to `token` (or set `CLOCKWORK_GITHUB_API`). It must start with `https://`.

## What an item looks like

- Channel: the repository, for example `acme/widgets`.
- Text: the reason in square brackets, the kind of thing and its title, then the latest comment if it could be read:
  `[review_requested] Pull request: Add a retry to the uploader`.
- Link: the comment, issue, pull request, commit or discussion on GitHub. For a release, a workflow run or a security
  alert the link goes to that section of the repository, not to the exact page.

## What it contacts

- `api.github.com` (or the server you named), with `GET` requests only: `/notifications`, and one request per new or
  updated thread for its latest comment.
- Clockwork on this machine.

Nothing else.

## What it keeps

In its private folder: `state.json` with the time it last looked, which threads it has already sent,
and when GitHub allows the next look. No notification text is kept there.

## Limits

- The first run brings the last 24 hours, marked as history. After that only what is new.
- With the `notifications` scope the token cannot read comments in **private** repositories, so those items carry the
  reason and the title only. Public repositories get the latest comment too. Set `CLOCKWORK_GITHUB_COMMENTS=0` to never
  fetch comments.
- It asks GitHub about once a minute, never more often than GitHub's `X-Poll-Interval` allows, and stops and waits when
  GitHub says it is being asked too often.
- Up to 500 notifications are read per look. Comment text is cut at 4,000 characters.
- Notifications you have already read on GitHub are brought in as well.

## Risks

- The token is a key to your notifications. Anyone who gets hold of it can read them, and could mark them as
  read. Give it an expiry date and delete it on GitHub when you stop using this.
- A work account belongs to your employer. Whether you may create a token and bring its notifications into a tool on your
  own machine is their decision; an organisation can also require tokens to be approved for single sign-on.
- Titles and comments of private work can end up in Clockwork's store on this machine and be shown to your agent.
