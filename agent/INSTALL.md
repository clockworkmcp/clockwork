# Installing Clockwork: instructions for the user's agent

Your user asked you to install Clockwork on this machine. Follow these steps in order. You run the commands; the user
only does the few things marked **user**. When you are done, you are also Clockwork's teacher: your working instructions
are in [SKILL.md](SKILL.md).

## Rules

- **Never print, copy or log a token or key.** Refer to the file that holds it. The user saves account tokens into files
  themself; do not ask them to paste one into the chat.
- **Never log in to an account for the user,** and never answer a login check or accept an agreement on their behalf.
- **Ask before installing anything system-wide** (Homebrew packages, a newer Node or Python). Say what and why.
- **Do not link an account the user did not ask for.** Ask which sources they want; link only those.
- Clockwork is read-only. Nothing in this install sends, replies or posts anywhere.
- If a step fails, stop and show the user the command and its output. Do not work around it.

## 1. Check what the machine has

```bash
node --version      # needs 24 or newer
uv --version        # preferred; otherwise a python3.10 to python3.13 must exist
```

macOS is the tested platform. If Node is too old or neither `uv` nor a suitable Python exists, tell the user and offer
`brew install node` / `brew install uv`. WhatsApp also needs Go (`brew install go`); X also needs Google Chrome. Only
mention those if the user wants those sources.

## 2. Install

From the folder that holds this project (the one with `install.sh`):

```bash
./install.sh
```

It installs into `~/.clockwork/v2` and links the command at `~/.local/bin/clockwork`. Nothing system-wide, no password.
If that folder is not on the PATH, use the full path in every command below.

```bash
clockwork doctor    # every line must say ok
clockwork start     # runs in the background and at login
clockwork status    # "core" and "scorer" must be running
```

The first start downloads the local model (about 470 MB), so `scorer` can take a few minutes to become ready.

## 3. Connect yourself

```bash
clockwork agent
```

This prints the MCP address (`http://127.0.0.1:4600/mcp`), the file holding your token, and the skill file. Add Clockwork
to your own MCP servers as an HTTP server that sends `Authorization: Bearer <contents of the token file>`, and install
[SKILL.md](SKILL.md) the way your runtime installs skills (for OpenClaw: copy this `agent/` folder into the skills folder
as `clockwork`). Confirm it works by calling `get_source_health`.

**If you run in a vendor's cloud and reach this machine remotely** (a ChatGPT dot, Grok Bot, Claude Duet), you cannot
use `127.0.0.1` for your regular work: your scheduled checks and event wake-ups run in the cloud. Clockwork then needs a
tunnel. Explain this to the user, including that it puts their message queue behind a login on the internet, and set it
up only after they say yes:

1. Ask which tunnel they want. Tailscale Funnel (`tailscale funnel 4600`) gives a stable address and needs a free
   account that the **user** creates and signs in to. `cloudflared tunnel --url http://127.0.0.1:4600` needs no account
   but its address changes on every restart, so it is only for trying things out. Ask before installing either program.
2. Put the tunnel's https address in `~/.clockwork/v2/config.json` as `"publicUrl"`, then `clockwork stop` and
   `clockwork start`.
3. The **user** adds `<address>/mcp` to you as a custom MCP server with OAuth, and approves the connection on
   Clockwork's own page with the admin token from that config file. Never read the token out or type it for them.
4. Subscribe to the events `urgent_item` and `heads_up_item` if your platform supports MCP events.

The details for each agent are in [docs/CONNECT.md](../docs/CONNECT.md).

## 4. Link the sources the user wants

Run `clockwork extractors` and tell the user which sources are available (WhatsApp, Gmail, Slack, X, Outlook, iMessage,
calendar, Discord, GitHub, GitLab, Linear, Jira, Bluesky, Mastodon, Hacker News, RSS). Ask which they want. For each
one run:

```bash
clockwork connect <name>
```

and relay exactly what it says. Each needs something only the user can do:

| Source | What the **user** does |
|---|---|
| WhatsApp | scans a QR code with their phone |
| Gmail | creates their own Google OAuth client, saves its file where `connect` says, approves access in the browser |
| Slack | creates a Slack app from `extractors/slack/slack-app.json`, installs it, saves its user token in the file `connect` names |
| X | logs in themself in the Chrome window that opens |
| any other | what `connect` prints; the steps are in `extractors/<name>/README.md` |

Details are in [docs/LOCAL.md](../docs/LOCAL.md) and each extractor's own `README.md`. Before linking, tell the user the risk stated in
[docs/RISKS.md](../docs/RISKS.md) for that source (WhatsApp and X can restrict accounts; a work Slack is the employer's
decision). Link it only after they say yes.

If they want a source that is not built in, follow [SOURCES.md](SOURCES.md) after the install is working.

## 5. Start teaching

Every source starts in shadow mode: the local model decides nothing until it agrees with you. Follow
[SKILL.md](SKILL.md): set up your recurring check, label what `get_items_to_label` returns, and tell the user about
urgent items.

## 6. Report back

Tell the user, without quoting any message content:

- the output of `clockwork doctor` and `clockwork status`,
- which sources are linked and which are waiting on them,
- anything that failed, with the command and its output (`clockwork logs <name>` shows a part's recent output).

To stop or remove: `clockwork stop` stops it and removes the login item; the data is the `~/.clockwork/v2` folder.
