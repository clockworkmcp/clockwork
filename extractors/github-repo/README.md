# GitHub repositories

Brings the activity of the GitHub repositories you name into Clockwork: issues and pull requests being opened, closed or
merged, comments, reviews, stars, forks, pushes and releases. One item per thing that happened. Everything about one issue
or pull request lands in the same thread.

This is for watching a project. For what GitHub addresses to *you* (mentions, review requests, failed runs), use the
[GitHub notifications](../github/README.md) extractor; both can run together and file under the same source, `github`.

It only reads. Every call to GitHub is a `GET` to the repository's activity list.

## Setting it up

1. Save the repositories, one `owner/name` per line, in the file `repos` in this extractor's private folder
   (`clockwork connect github-repo` tells you where that is).
2. **Public repository:** nothing else is needed.
   **Private repository:** on GitHub open **Settings**, **Developer settings**, **Personal access tokens**,
   **Fine-grained tokens**, then **Generate new token**. Under "Repository access" choose **Only select repositories** and
   pick the repository. Under "Repository permissions" set **Metadata**, **Issues**, **Pull requests** and **Contents** to
   **Read-only**. Leave everything else at "No access". `clockwork connect github-repo` asks for it, without showing what
   you paste, and keeps it in the macOS Keychain. Press Enter there if every repository is public.
3. Optional: to leave out your own activity (your pushes, your comments), put your GitHub login in the file `skip`, one per
   line.
4. `clockwork check github-repo`, `clockwork connect github-repo`, then `clockwork enable github-repo`.

On a hosted machine the lists can be given as `CLOCKWORK_GITHUB_REPOS` and `CLOCKWORK_GITHUB_REPO_SKIP` (names separated by
commas or spaces), and the token goes in the host's secret store as `CLOCKWORK_SECRET_GITHUB_REPO_TOKEN`.

## What an item looks like

- Channel: the repository, for example `acme/widgets`.
- Text: what happened in square brackets, then the title, then what was written:
  `[issue opened] #12 Widget crashes on empty input`, `[star] dana-example starred acme/widgets`.
- Link: the issue, pull request, comment, release or fork on GitHub. For a star the link is the person's profile.

## What it contacts

- `api.github.com` (or the server named in the file `api`, for GitHub Enterprise), with `GET` requests only:
  `/repos/OWNER/NAME/events`, and one request per pull request whose title GitHub left out of the list.
- Clockwork on this machine.

Nothing else.

## What it keeps

In its private folder: `repos`, the optional `skip`, and `state.json` with the place it has read up to in each
repository. No issue or comment text is kept there, and the token never is.

## Limits

- **It can be late.** GitHub says its activity list is not real time: an entry can appear anything from half a minute to a
  few hours after the fact. Do not rely on this for anything that needs a reply within minutes.
- GitHub keeps about 300 entries, and nothing older than 30 days. The first run brings the last 24 hours, marked as history.
- Without a token GitHub allows 60 requests an hour, so it looks every five minutes; with a token, about once a minute. It
  never looks more often than GitHub's `X-Poll-Interval` allows.
- A star shows who starred, not the new total. Someone removing a star is not reported by GitHub at all.
- Pushes carry the branch and, where GitHub includes them, the first line of each commit message.

## Risks

- A token for a private repository can read that repository's code and issues. Give it an expiry date, limit it to the one
  repository, and delete it on GitHub when you stop using this.
- Titles and comments of private work end up in Clockwork's store and are shown to your agent.
- Issues and comments are written by strangers. Clockwork treats their text as content to sort, never as instructions, and
  your agent should do the same.
