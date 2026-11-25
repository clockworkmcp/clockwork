# Adding sources: instructions for the user's agent

Use this when the user wants Clockwork to read something more ("add my Telegram", "can it watch this RSS feed?").
Paths below are relative to the Clockwork folder (`clockwork agent` prints where it is).

First work out which case it is:

1. `clockwork extractors` lists what is installed. If the source is there but off, it is **case A**.
2. Otherwise look at the "Community extractors" table in `extractors/WANTED.md`. If someone has published one and the
   user wants to use it, it is **case B**.
3. Otherwise you write one: **case C**.

Rules for all three:

- **Read-only.** A source may only read. Never add one that sends, replies, reacts, posts or marks as read.
- **The user decides.** Do not link, add, switch on, update or publish anything they did not ask for.
- **Never print a token or key,** and never log in for the user. They save credentials into files themself.
- **Say the risk first.** Reading an account automatically can break that service's rules, and a work account is the
  employer's decision. Tell the user before linking, and wait for their yes.

## A. A source that is already installed

```bash
clockwork connect <name>
```

Relay exactly what it prints; it names the one thing the user must do (scan a code, log in, save a token file). Then
`clockwork status` until the source reports in. Details per source: `docs/LOCAL.md`.

## B. An extractor someone else wrote

This is code from outside that will run as the user. Nobody at Clockwork has reviewed it.

1. Only do this when the user chose that extractor themself. Do not go looking for one on your own.
2. Read its code before anything else. Tell the user in plain words what it reads, what it stores, which hosts it talks
   to, and anything that is not needed for reading the feed. If it sends, posts, or contacts a host it has no reason
   to, say so and recommend against it.
3. Pin a version: `clockwork add <git address>#<tag or commit>`. It shows what will be installed and run and asks for
   consent. **That question is the user's to answer.** Show it to them; never answer it for them.
4. `clockwork check <name>`, then `clockwork connect <name>` (or `enable`), then `clockwork status`.

It never updates by itself. `clockwork update <name>` fetches a newer version and asks again; read what changed first.
`clockwork remove <name>` deletes it.

## C. Writing one

```bash
clockwork new <name> <kind> # a working template in ~/.clockwork/v2/extractors/<name>/
clockwork check <name>      # trial run against a stand-in, then offline over the sample input; touches none of the user's items
clockwork enable <name>
```

1. Read `docs/EXTRACTORS.md` (the contract). Pick the template by how the source is reached: `api` for a service with
   an API and a key, `mac-app` for another app's own store on this Mac, `basic` otherwise. Change what
   its `main.mjs` marks "Replace".
2. Prefer the service's official API with the narrowest read-only permission it offers. If the only way is an unofficial
   one, tell the user that and the risk to their account before writing it.
3. Keep it small and dependency-free where you can. Keep credentials and state in the extractor's own data folder
   (`CLOCKWORK_EXTRACTOR_DATA`), in files only the user can read. Use only the ingest token it is given.
4. Go slowly on the service: a pause between calls, back off when it says to, never retry in a tight loop.
5. Give every item a stable `sourceId` so nothing is brought in twice, and mark old items brought in on the first run
   with `origin: "history"`.
6. If it needs a key or password, declare it in `extractor.json` under `secrets` with a `help` line. `clockwork connect`
   then asks the user for it in their own terminal and keeps it in their Keychain; your program reads it from
   `CLOCKWORK_SECRET_<NAME>`. Never have the user save a key in a file, never write one to disk, and never see it
   yourself: the user runs `clockwork connect <name>`, not you.
7. Write the sample input in `fixtures/` to match what the source really gives, **with every name, address, id and
   message made up**. Learn the shape from the service's documentation, or from the user's real data read-only, but
   never copy a real value into a file. `clockwork check` runs your code over it offline, whole and damaged.
8. Run `clockwork check <name>` until it passes. **Show the user what you wrote** and what it reads before you switch
   it on.

A new source starts in shadow mode: the model decides nothing for it until it agrees with your labels, so label its
first items promptly.

## Contributing an extractor you wrote

If one you wrote works well, offer to share it. Others install it with `clockwork add`. It lives in **the user's own
repository**, not in Clockwork's; Clockwork only lists it.

**Publishing is the user's decision and happens under their name. Ask first, and publish only on a clear yes.** Do not
create a repository, push, or open a pull request before that.

Before you ask, get it ready:

- It has run on the user's install for at least a few days without errors (`clockwork logs <name>`).
- `clockwork check <name>` passes.
- **Nothing of the user's is in it.** No tokens, no account names or ids, no real message content in code, comments,
  tests, examples or commit history. Make example data up. Start the repository from a fresh copy of the folder, not
  from one whose history ever held a credential, and leave the data folder out.
- It has a `README.md` that says: what it reads, which permissions or scopes it needs and how to get them, every host
  it contacts, what it stores and where, the risk to the account, and that it is read-only.
- It has a licence file (Apache-2.0 or MIT unless the user wants another) and, if it has tests, they pass.
- Its name does not suggest it is official (`clockwork-telegram` is fine; "Clockwork Telegram by Telegram" is not).

Then, with the user's yes:

1. Show the user the exact files that will become public. Publish them as a public repository under the user's account
   and tag a version (`v0.1.0`).
2. From a clean data folder, confirm a stranger can install it:
   `CLOCKWORK_DATA=$(mktemp -d) clockwork init`, then `clockwork add <git address>#v0.1.0` and `clockwork check <name>`
   with that same `CLOCKWORK_DATA`.
3. Open a pull request to the Clockwork repository that adds **one row** to the "Community extractors" table in
   `extractors/WANTED.md` (source, repository, author, a short note) and changes nothing else. If the source was on
   the "Wanted" list, remove it there in the same pull request. In the description say what was checked on a real
   install and that an agent wrote it and the user read it.
4. Tell the user they are now its maintainer: people will open issues on their repository, and a service changing its
   API will break it. If they do not want that, do not publish.

Later fixes go to the user's repository as new tagged versions. Nobody's install changes until they run
`clockwork update`.
