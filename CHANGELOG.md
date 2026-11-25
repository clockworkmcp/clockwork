# Changelog

What changed for someone running Clockwork, newest first. `clockwork version` shows what you have and
`clockwork upgrade` moves you to the newest.

## Unreleased

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
