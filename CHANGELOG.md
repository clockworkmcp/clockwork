# Changelog

What changed for someone running Clockwork, newest first. `clockwork version` shows what you have and
`clockwork upgrade` moves you to the newest.

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
