# Contributing

Clockwork is a small project. These rules keep it possible to say yes quickly.

## The easiest contribution is an extractor

Most "can it also read X?" requests are an extractor, and an extractor does not need to live in this repository:

```bash
clockwork new my-feed
clockwork check my-feed
```

Publish it in your own repository and add it to the list in [extractors/WANTED.md](extractors/WANTED.md) with a pull
request that changes only that file. Others install it with `clockwork add <your git address>`. Community extractors
are listed, not reviewed. The contract is in [docs/EXTRACTORS.md](docs/EXTRACTORS.md). An extractor must be read-only:
one that sends, replies or marks as read will not be listed.

If your agent wrote the extractor, [agent/SOURCES.md](agent/SOURCES.md) has the steps for it to publish and list it,
with you approving what goes public.

## Bugs

Open an issue with what you ran, what happened, and the output of `clockwork doctor` and `clockwork status`.
**Never paste message content, tokens, or files from `~/.clockwork`.** Security problems go through
[SECURITY.md](SECURITY.md), not issues.

## Changes to the core

- Open an issue first and wait for a yes, except for small fixes. Unrequested features and refactor-only changes will
  be closed.
- One change per pull request, with tests. Run them before you open it:

  ```bash
  (cd core && node --test) && node --test cli/test/cli.test.mjs
  ```

- Say in the pull request how you checked it on a real install, and what you did not check.
- No new dependencies in `core/` or `cli/` without discussion. Nothing that sends on the user's behalf, phones home, or
  widens what a token can do.
- Written with an AI agent is fine. You must have read the change, run it, and be able to answer questions about it.
  Point your agent at [AGENTS.md](AGENTS.md).
- No real message content in code, tests, fixtures or screenshots. Use made-up examples.

## What to expect

Issues and pull requests are looked at once a week. Out-of-scope requests are closed with a short reason; that is not a
judgement of the idea. Contributions are accepted under the project's licence (Apache-2.0).

Be decent to each other: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
