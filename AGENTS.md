# Instructions for coding agents

Clockwork is personal message triage that runs on the user's own machine. Read this before changing anything. If you are
an agent *using* a Clockwork install (labelling items, raising urgent ones), your instructions are in
[agent/SKILL.md](agent/SKILL.md), not here. If your user asked you to *install* it, follow
[agent/INSTALL.md](agent/INSTALL.md).

## Layout

- `cli/` the `clockwork` command (`clockwork.mjs`), shared config and manifest code (`lib.mjs`), the process supervisor
  (`supervisor.mjs`). Node, no dependencies.
- `core/` the service: SQLite store, ingest, the decision cascade, HTTP and MCP. Node.
- `student/` the local model: scorer (`serve.py`) and trainer (`train.py`). Python.
- `connectors/` the programs behind the built-in extractors (WhatsApp in Go, Gmail and X in Node). The others
  (Slack, Outlook, GitHub, RSS and so on) keep their program, test and README with the manifest in `extractors/<name>/`,
  which is the layout new extractors should use.
- `extractors/` one folder per built-in extractor with its `extractor.json`, plus `template/`.
- `agent/SKILL.md` instructions for the user's agent; `agent/INSTALL.md` how an agent installs Clockwork; `agent/SOURCES.md`
  how it adds sources and shares extractors it wrote. `docs/` user documentation.

## Commands

```bash
(cd core && npm ci && node --test)        # core tests
node --test cli/test/cli.test.mjs         # CLI and supervisor tests
(cd connectors/gmail && node --test)      # Gmail reader tests
node --test extractors/*/*.test.mjs       # tests of the extractors that live in extractors/
clockwork check <extractor>               # validate an extractor and do one trial run
```

Use a throwaway data folder for anything you run: `CLOCKWORK_DATA=$(mktemp -d) clockwork init`. Never run against, read
or print anything under `~/.clockwork`: it holds the user's real messages and tokens.

## Rules that are not negotiable

- **Read-only.** Nothing may send, reply, react, post or mark as read on any account.
- **No real message content** in code, tests, fixtures, logs or commit messages. Make examples up.
- **Never print a token.** Point at the file that holds it.
- **Least privilege.** Extractors get the ingest token only. Do not pass other environment to them, and do not widen
  what the agent or ingest token can reach.
- **Loopback by default.** New listeners bind `127.0.0.1`.
- **Uncertainty never becomes `ignore`,** and the local model never decides `urgent`.
- **No outside code without consent.** Nothing is downloaded and run, installed or updated unless the user said yes to
  that exact thing.
- **No new dependencies** in `core/` or `cli/` without the maintainer's agreement.

## Style

Short files, plain Node (ES modules) and Python, no build step. Match the surrounding code. Every behaviour change comes
with a test. User-facing text is plain English with no jargon.

## Writing an extractor

Start from `clockwork new <name>`; the contract is [docs/EXTRACTORS.md](docs/EXTRACTORS.md). It belongs in its author's
own repository unless the maintainer asked for it here. Run `clockwork check <name>` until it passes.

## Pull requests

Follow [CONTRIBUTING.md](CONTRIBUTING.md): an issue first for anything but a small fix, one change per pull request,
tests run, and a note on what was and was not checked on a real install. The human who opens it must have read it.
