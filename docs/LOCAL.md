# Running Clockwork on your own machine

Clockwork is meant to live on a machine that stays on (a Mac mini, a home server, a laptop that rarely sleeps), next to
your agent. Your messages, the model and its training are stored on that machine. The one place content goes elsewhere is
your agent: it reads items to label them, so they reach whatever model your agent runs on.

## What you need

- macOS on Apple Silicon is the tested setup. Linux should work with `clockwork run` under your own service manager.
- Node 24 or newer, Python 3.10 to 3.13 (with `uv` if you have it: `brew install uv`). For WhatsApp: Go (to build its reader once). For X: Google Chrome.
- About 2 GB of disk for libraries and the model, and 2 GB of free memory.
- An agent that speaks MCP and can run on a schedule (OpenClaw, Claude, Codex, ChatGPT with a tunnel).

## Install

```bash
git clone <this repository> clockwork && cd clockwork
./install.sh
clockwork start
```

`install.sh` puts everything in `~/.clockwork/v2` and this folder, links the `clockwork` command into `~/.local/bin`, and
creates the config with fresh access tokens. It installs nothing system-wide and asks for no password.
`clockwork start` runs the service now and at every login. `clockwork doctor` checks an install.

## Link your accounts

Each of these tells you what to do yourself. Clockwork never sees a password.

```bash
clockwork connect whatsapp    # scan a code with your phone (Linked devices)
clockwork connect gmail       # approve read-only access in your browser
clockwork connect slack       # after saving a token for a Slack app you create (below)
clockwork connect x           # log in to X in a separate Chrome window
clockwork status
```

`clockwork extractors` lists every source. Twelve more are built in, each with its own setup page:
[Outlook mail](../extractors/outlook/README.md), [iMessage and SMS](../extractors/imessage/README.md),
[calendar invitations](../extractors/calendar/README.md), [Discord](../extractors/discord/README.md),
[GitHub](../extractors/github/README.md), [GitLab](../extractors/gitlab/README.md),
[Linear](../extractors/linear/README.md), [Jira](../extractors/jira/README.md),
[Bluesky](../extractors/bluesky/README.md), [Mastodon](../extractors/mastodon/README.md),
[Hacker News](../extractors/hackernews/README.md) and [RSS / Atom feeds](../extractors/rss/README.md).
`clockwork connect <name>` tells you what each one needs. These twelve and Slack have so far only been tested against
stand-ins for the real service.

### Gmail

Gmail needs an OAuth client of your own, because Clockwork has no central service that could hold one for you:

1. In the Google Cloud console create a project, switch on the Gmail API, and set up the consent screen as "External".
   Then set its publishing status to **In production**. Left in "Testing", Google ends the access after seven days and
   you would have to link again every week. You do not need Google's verification for your own use; you will see an
   "unverified app" warning once when you approve it, which is expected because the app is yours.
2. Create credentials of type "OAuth client ID", application type "Desktop app", and download the JSON file.
3. Save it as `~/.clockwork/v2/gmail/client.json`, then run `clockwork connect gmail`.

### Slack

Slack is read through Slack's own API by an app that belongs to you and can only read:

1. Go to api.slack.com/apps, choose "Create New App", then "From a manifest", pick your workspace and paste the contents
   of `extractors/slack/slack-app.json`.
2. Choose "Install to Workspace" and approve it. On a work Slack this may send a request to an admin instead.
3. Under "OAuth & Permissions" copy the **User OAuth Token** (it starts with `xoxp-`) and save it as the only line of
   `~/.clockwork/v2/extractor-data/slack/token`. Keep that file to yourself: `chmod 600` it.
4. Run `clockwork connect slack`.

It reads the conversations you are a member of: direct messages first, then group messages and channels. The first time
it brings in the last 24 hours. Replies inside threads are picked up within about 15 minutes, for threads started in the
last two days. With several hundred channels a full pass takes a few minutes. The app has no permission to post, react
or mark anything as read. To stop: `clockwork disable slack`, and remove the app at api.slack.com/apps.

**A work Slack is your employer's data.** Reading it into Clockwork copies it to this machine and shows it to your agent
and the model your agent runs on. Check that you are allowed to do that before you connect it.

### WhatsApp

Read as a linked device through the open-source whatsmeow library, which is not an official WhatsApp client. WhatsApp's
terms do not allow unofficial clients and it can restrict or ban an account that uses one. Clockwork only reads, which
keeps it quiet, but nobody can promise your account is safe. Consider linking a secondary number first.

### X

Off unless you connect it. A separate Chrome profile on this machine opens your home timeline every half hour and reads
what the page loads. X may restrict an account that is read on a schedule; it is your account and your call. If X shows a
check, Clockwork stops and waits for you; it never answers one.

## Connect your agent

```bash
clockwork agent
```

prints the MCP address, where the agent's token is stored, and the skill file to give your agent (`agent/SKILL.md`). The
agent is the teacher: it labels what Clockwork collects, and a small model on your machine learns to do the same.
Steps for OpenClaw, Hermes Agent, ChatGPT dots, Grok Bot and Claude Duet are in [CONNECT.md](CONNECT.md).

**The first day.** Every source starts in shadow mode: the model predicts and decides nothing. Have your agent label the
backlog. Once a source has 200 labels it is trained every night, and when 30 of its confident predictions have been checked
by the agent and 95% matched, it starts filing what it is sure of. It never decides "urgent" on its own, and anything it is
unsure of still goes to the agent. `clockwork status` shows where each source stands.

**Heads-ups.** Your agent normally checks for new items on a schedule. It can also ask to be woken as soon as certain
messages arrive, for example anything from your child's school. That wakes the agent, not you: it looks at the message
and tells you only if it thinks you need to know. See "Heads-ups" in [REFERENCE.md](REFERENCE.md).

## Reaching Clockwork from outside

By default Clockwork listens only on this machine. Most hosted agents (ChatGPT dots, Grok Bot, Claude Duet) run in
their vendor's cloud and need a public https address that forwards to `http://127.0.0.1:4600`. Run a tunnel for that:
`tailscale funnel 4600` (stable address, free account) or, to try things out, `cloudflared tunnel --url
http://127.0.0.1:4600` (no account, but the address changes on every restart). Put the address in
`~/.clockwork/v2/config.json` as `"publicUrl"`, then `clockwork stop` and `clockwork start`. The agent signs in with
OAuth and you approve it with the admin token from the same file. Do this only if you need it: it puts your message
queue behind a login on the internet. The full steps, and the alternative of running Clockwork on a remote machine,
are in [CONNECT.md](CONNECT.md).

## Where things are

| | |
|---|---|
| `~/.clockwork/v2/config.json` | settings and access tokens (readable only by you) |
| `~/.clockwork/v2/clockwork.db` | every item, decision and label |
| `~/.clockwork/v2/logs/` | output of each part (`clockwork logs core`) |
| `~/.clockwork/v2/extractors/` | extractors you added or wrote |
| `~/.clockwork/v2/student/` | the trained model and the downloaded embedding model |

Nothing is encrypted beyond your disk's own encryption, so turn on FileVault. To remove Clockwork: `clockwork stop`, delete
`~/.clockwork/v2` and this folder, and remove the linked device in WhatsApp and the app's access in your Google account.

## Settings in `config.json`

| Key | Default | |
|---|---|---|
| `teacherMode` | `agent` | `builtin` uses Claude with `ANTHROPIC_API_KEY` from the environment instead of, or beside, your agent |
| `graduateAgreement` | `0.95` | how often the model's confident calls must match the agent's before a source leaves shadow mode |
| `retrainHours` | `24` | how often the model is retrained |
| `tz` | your system's | timezone used to read times written in messages |
| `port`, `studentPort` | `4600`, `4601` | local ports |
| `publicUrl` | none | see "Reaching Clockwork from outside" |
