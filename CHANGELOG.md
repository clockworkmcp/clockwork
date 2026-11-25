# Changelog

What changed for someone running Clockwork, newest first. `clockwork version` shows what you have and
`clockwork upgrade` moves you to the newest.

## Unreleased

- **Your agent can search everything.** The new `search_items` tool finds past items in any bucket, ignored ones
  included, by words, sender, group, source and time, and can read one conversation whole. Until now an agent could only
  list a bucket.
- **Watch a GitHub repository.** `clockwork connect github-repo` brings in what happens on the repositories you list:
  issues, pull requests, comments, reviews, stars, forks, pushes and releases. A public repository needs no token.
  GitHub's activity list can run minutes to hours late: see
  [extractors/github-repo/README.md](extractors/github-repo/README.md). Tried against one real repository's activity.
- **An extractor's key can be optional.** `"optional": true` in a manifest's `secrets` is for a key the program runs
  without; pressing Enter at `clockwork connect` skips it.
- **Fixed: X capture on your own Mac could stop for good.** When the hidden browser lost its only page, the connector
  kept reporting "the browser did not answer" until it was restarted by hand. It now opens a new page.
- **Account keys move out of plain files into your Keychain.** `clockwork connect` now asks for the token or app
  password itself, without showing it, and keeps it in the macOS Keychain. This covers GitHub, GitLab, Linear, Discord,
  Slack and the new Gmail app-password extractor. **If you saved a token file before, run `clockwork connect <name>`
  once:** it moves the token into the Keychain and deletes the file. Until then the old file keeps working, and
  `clockwork doctor` points it out. Files that other users of the machine could read are tightened automatically.
  Bluesky, Jira and Mastodon logins, and the sessions that WhatsApp, X, Google and Microsoft hand back, are still files
  only you can read.
- **Templates by kind.** `clockwork new <name> api` starts an extractor for a service with an API and a key;
  `clockwork new <name> mac-app` starts one that reads another app's store on this Mac. `clockwork new <name>` alone
  still gives the small one.
- **`clockwork check` tries an extractor offline.** Put made-up sample input in its `fixtures/` folder and the check
  runs the program over it with no account and no network: once whole, then with each file cut short and unreadable.
  An extractor that stops without a word on damaged input, or sends a malformed item, fails.
- **Gmail with an app password.** `clockwork connect gmail-imap` reads Gmail over IMAP with a Google app password, so
  there is no Google Cloud project to set up. An app password can do more than read, and only the program keeps it to
  reading: see [extractors/gmail-imap/README.md](extractors/gmail-imap/README.md). It files mail under the same ids as
  the `gmail` extractor, so you can switch between them. Not yet run against a real account.

## 0.2.0 (2026-11-18)

First public version.

- **`clockwork upgrade`** fetches the newest Clockwork, shows what is new, asks, and restarts the service.
  `clockwork upgrade --check` only looks. `clockwork version` shows the version you are on.
- **`clockwork demo`** runs a throwaway copy with made-up messages, so you can connect an agent, watch it label, and see
  it woken by a heads-up before you link a real account.
- **Setup has a finish line.** The agent tool `get_setup_status` (and `clockwork status`) lists what is still missing:
  a feed delivering, the agent connected, wake-ups arranged, labelling started. Agents are told to keep going until all
  four are done.
- Heads-ups: an agent can ask to be woken for certain messages as they arrive (`heads_up_item`).
- Dates, deadlines, urgency words and money amounts are recognised in nine languages.
