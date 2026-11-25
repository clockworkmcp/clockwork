# Extractors

An extractor brings items from one place (a chat app, a mailbox, a feed) into Clockwork. It is a separate program, in any
language, that posts items to the core on this machine. Everything after that (de-duplication, thread context, labelling,
training, alerts, health) is the same for every source.

Extractors are **one-way and read-only by contract**: they bring items in. Nothing in Clockwork sends, replies or posts, and
an extractor should not either.

## The contract

```
POST http://127.0.0.1:4600/ingest/events
Authorization: Bearer $CLOCKWORK_INGEST_TOKEN
Content-Type: application/json

{ "source": "my-source", "events": [ ... ], "status": "ok", "account": "optional name when you run several" }
```

The answer is `{ "received": n, "new": m }`. Sending an item twice is harmless: the same `sourceId` is stored once.

Send the request with an **empty `events` list at least every 15 minutes** as a heartbeat. That is how Clockwork tells
"running, nothing new" from "stopped". Put the extractor's state in `status`: `ok`, or a short word such as `needs_login`
or `error`, which is shown to the user and their agent.

### An item

| Field | Required | Meaning |
|---|---|---|
| `sourceId` | yes | Stable id of the item where it came from. |
| `text` | | The content. Leave empty when there is content Clockwork cannot read, and set `kind`. |
| `threadId` | | The conversation it belongs to. Earlier items in a thread are shown to the model and the agent as context. |
| `author` | | Stable id of the sender (address, handle, number). |
| `authorName` | | How the sender is shown. |
| `sourceTime` | | When it was sent (ISO 8601). Queues and digests are ordered by this. |
| `direction` | | `incoming` (default) or `outgoing` for what the user wrote themself. Outgoing items are never triaged; they are context. |
| `isGroup` | | True for a group conversation. |
| `kind` | | `text` (default), or `image`, `video`, `audio`, `document`, ... when the content is not text. The model never files such an item alone. |
| `url` | | Where to open the item. |
| `chatName` | | Name of the group or channel. |
| `origin` | | Start it with `history` for items replayed from the past, so they do not count as late arrivals. |

Size limit: 8 MB per request. Send large backlogs in batches of a few hundred.

### What Clockwork gives the program

| Variable | |
|---|---|
| `CLOCKWORK_CORE_URL` | Address of the core. |
| `CLOCKWORK_INGEST_TOKEN` | A token that can only write items. It cannot read anything back. |
| `CLOCKWORK_EXTRACTOR_DATA` | A private folder for the extractor's own state and credentials. |
| `CLOCKWORK_SECRET_<NAME>` | Each key the manifest's `secrets` asked the user for, e.g. `CLOCKWORK_SECRET_TOKEN`. Only this extractor's own. |
| `CLOCKWORK_FIXTURES` | Only during `clockwork check`: a folder of sample input to read instead of the real source. See [Fixtures](#fixtures). |

Plus `PATH`, `HOME` and locale, and whatever the manifest's `env` adds. It does not get the admin token, the agent token or
any model key.

## The manifest: `extractor.json`

```json
{
  "name": "my-source",
  "source": "my-source",
  "description": "What this brings in, in one sentence.",
  "install": { "command": "npm", "args": ["ci"] },
  "run": { "command": "node", "args": ["main.mjs"] },
  "env": { "MY_SETTING": "{extractorData}/settings.json" },
  "secrets": [{ "name": "token", "prompt": "My Source token", "help": "Where to get a read-only one.", "pattern": "^ms_" }],
  "requires": [{ "file": "{extractorData}/settings.json", "help": "What to put in it." }],
  "ready": { "file": "{extractorData}/token.json" },
  "connect": { "type": "command", "command": "node", "args": ["main.mjs", "auth"], "note": "What the user will be asked to do." },
  "restartSeconds": 60
}
```

- `name`: lower-case letters, digits and dashes, starting with a letter. `source`: the name items are filed under; several extractors may share one.
- `run` (required): started in the extractor's folder and kept running. If it exits it is started again after `restartSeconds`.
- `install`, `build`: run once by `clockwork connect <name>`.
- `secrets`: the keys to the user's account (an API token, an app password). `clockwork connect` asks for each, without
  showing what is typed, checks it against `pattern` if there is one, and keeps it in the macOS Keychain (elsewhere, a
  file only the user can read; on a hosted machine, the host's secret store). The program gets it in
  `CLOCKWORK_SECRET_<NAME>` each time it starts, and is not started until every one is there. **Never ask for a key in
  a `requires` file, and never write one to disk yourself.** `"hidden": false` is for what is not secret (an address);
  `"optional": true` is for a key the program can run without (a token only a private repository needs): pressing Enter skips it;
  `"file": "{extractorData}/token"` names a file that used to hold the key, which `connect` moves and deletes.
- `requires`: other files the user must supply before connecting (settings, not keys); `help` is shown if one is missing.
- `ready`: the extractor is not started until this file exists (typically the saved login).
- `connect`: how the user links their account. `command` runs a program in the terminal; `open` shows a page served by the
  extractor on this machine (`http://127.0.0.1:...` only); `flag` creates a file the running extractor watches for.
- `{data}` is Clockwork's data folder, `{extractorData}` this extractor's private folder, `{dir}` its own folder.

## Writing one

```bash
clockwork new my-source api      # copies a template into ~/.clockwork/v2/extractors/my-source
cd ~/.clockwork/v2/extractors/my-source
$EDITOR main.mjs                 # change what is marked "Replace"
$EDITOR fixtures/*               # made-up sample input, shaped like what the real source gives
clockwork check my-source        # validates the manifest, gives it one trial run, then runs it offline over the fixtures
clockwork connect my-source      # or `enable`, when there is no account to link
clockwork status
```

Pick the template by how the source is reached:

| Kind | When | What it already does |
|---|---|---|
| `basic` (the default) | nothing below fits | reports in, keeps state, about fifty lines |
| `api` | the service has an API you call with a key or token | asks for the key and keeps it in the Keychain, sends it to one host only, paces its requests, waits when the service says to, reports `needs_login` when the key stops working, reads newest-first pages back to what it has |
| `mac-app` | the source is another app's own store on this Mac, a SQLite file | opens the store read-only, reports `needs_login` until macOS allows it, names the table or column an app update took away, reads rows newer than the last one |

Each is plain Node with no dependencies. An agent can write an extractor for you from one of them and this page. Its own
instructions for that, and for sharing the result, are in [agent/SOURCES.md](../agent/SOURCES.md).

## Fixtures

An extractor meets its real source for the first time on someone's account. Fixtures let its reading code be tried
before that, with no account and no network.

Put small, **made-up** samples of what the source gives in a `fixtures/` folder next to `extractor.json`: an API's JSON
answers, the SQL that builds a tiny copy of an app's store, a few mail files. Never copy real messages, names or ids
into them. When `CLOCKWORK_FIXTURES` is set, the program must read that folder **instead of** its real source and
contact nothing but the core. The templates show the one line this takes.

`clockwork check` then runs the program offline, several times:

1. **Whole.** At least one item must come out, and every item must be one the core would accept.
2. **Damaged.** Once for each file cut off half way, and once for each file replaced by bytes that are not what its name
   says. Real sources do both: a download stops, a store is copied mid-write, an API answers with an error page. The
   program must still report in (an empty list with status `error` is the right answer) and must not send a malformed
   item. One that stops without a word fails the check: the service would restart it for ever and nobody would be told
   why.

Each run gets a copy of the folder, a throwaway data folder and a stand-in for the core, so your fixtures, your state
and your items are untouched. Fixtures are optional; without them the check says the reading code was not tried.

## Adding someone else's

```bash
clockwork add https://example.com/someone/clockwork-telegram.git     # or a local folder; add #v1.2 or #<commit> to pick a version
clockwork check telegram
clockwork connect telegram
clockwork update telegram                                            # later, only when you choose to
```

`clockwork add` shows what the extractor installs and runs, and the exact version (commit) it fetched, and asks before
copying anything. That version is what stays on your machine: nothing is ever installed or updated from the network on its
own. `clockwork update` fetches the newest version, shows the same summary, and asks again. `clockwork extractors` shows
which version you have. Community extractors are listed in [extractors/WANTED.md](../extractors/WANTED.md); listed does not
mean reviewed.

`clockwork check` tells you the program follows the contract. It cannot tell you what else the program does.

**An added extractor is other people's code running as you.** Clockwork limits what it can do *to Clockwork* (it can write
items and nothing else), but it does not sandbox the program: it can read your files and use the accounts you link to it.
Add only what you trust, as you would with any other software. The three built-in extractors live in this repository.

## A new source and the model

A new source starts with no model of its own, so every item goes to the agent. After about 200 labels it gets its own model
at the nightly retrain, and it starts filing confident items once those predictions have held up against the agent's labels.
If the extractor can fetch history, send it on the first run (with `origin: "history"`): the agent can label a backlog in one
sitting and the source is useful on day one.
