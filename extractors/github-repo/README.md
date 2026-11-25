# GitHub repositories

Brings what happens on the GitHub repositories you name into Clockwork: issues and pull requests being opened, closed,
merged or reopened, comments, commits, stars, forks, reviews and releases. One item per thing that happened. Everything
about one issue or pull request lands in the same thread.

This is for watching a project. For what GitHub addresses to *you* (mentions, review requests, failed runs), use the
[GitHub notifications](../github/README.md) extractor; both can run together and file under the same source, `github`.

It only reads. Every call to GitHub is a `GET`.

## Setting it up

1. Save the repositories, one `owner/name` per line, in the file `repos` in this extractor's private folder
   (`clockwork connect github-repo` tells you where that is).
2. **Public repository:** nothing else is needed, though a token makes it quicker and steadier (see Limits).
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
  `[issue opened] #12 Widget crashes on empty input`, `[star] dana-example starred acme/widgets (41 in all)`.
- Link: the issue, pull request, comment, release or fork on GitHub. For a star the link is the person's profile.

## What it contacts

- `api.github.com` (or the server named in the file `api`, for GitHub Enterprise), with `GET` requests only. For each
  repository: the repository itself, its issues, issue comments, pull request comments and commits changed since the last
  look, its activity list, and its stargazers and forks when their count changed.
- Clockwork on this machine.

Nothing else.

## What it keeps

In its private folder: `repos`, the optional `skip`, and `state.json` with the time it last looked, the open or closed
state of the issues it has seen, and which activity entries it has read. No issue or comment text is kept there, and
the token never is.

## Limits

- **Issues, pull requests, comments, commits, stars and forks arrive within one look**: about a minute with a token, a
  quarter of an hour without.
- **Releases, reviews and new branches can be late.** They come from GitHub's activity list, which GitHub says can run
  from half a minute to a few hours behind.
- **A token is worth having even for a public repository.** Without one GitHub allows 60 requests an hour for everyone
  behind the same network address, which a shared or hosted machine can use up. Any fine-grained token with
  "Public repositories (read-only)" access and no permissions at all is enough.
- The first run brings the last 24 hours, marked as history.
- A star shows who starred and the new total. Someone removing a star is not reported.
- Who closed an issue is not reported, only that it was closed (or, for a pull request, merged).
- Commits are those on the main branch, with the first line of each message.

## Risks

- A token for a private repository can read that repository's code and issues. Give it an expiry date, limit it to the one
  repository, and delete it on GitHub when you stop using this.
- Titles and comments of private work end up in Clockwork's store and are shown to your agent.
- Issues and comments are written by strangers. Clockwork treats their text as content to sort, never as instructions, and
  your agent should do the same.
