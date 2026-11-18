# Security

## Reporting a problem

Use **Report a vulnerability** on this repository's Security tab (GitHub private vulnerability reporting). Please do not
open a public issue for something that exposes people's messages. You will get an answer within a week. There is no bug
bounty. Never include real message content, tokens or session files in a report.

## What Clockwork is trusted with

Clockwork runs as you, on your machine, and holds your message history, the sessions for the accounts you linked, and
three access tokens. It trusts:

- **Your user account and your disk.** Anyone who can read your home folder can read everything. Data is not encrypted
  beyond the disk's own encryption.
- **The agent you give the agent token to.** It can read every item and label it, including as `ignore`.
- **Every extractor you switch on.** An extractor is a program that runs as you. Built-in ones are reviewed with the
  project. Added ones are not reviewed by anyone and are not sandboxed.

## What the design guarantees

- **Nothing sends.** No code path in the core or the built-in extractors sends, replies, reacts, posts or marks as read.
- **Local only by default.** The core, the model and the link pages listen on `127.0.0.1`. A public address exists only
  if you set `publicUrl` yourself.
- **Three tokens with separate powers.** Admin (everything), agent (`POST /mcp` only), ingest (write items only, never
  read). Extractors receive only the ingest token, and a manifest cannot override Clockwork's tokens or addresses.
- **Extractors are never installed or updated from the network without you.** `clockwork add` and `clockwork update`
  show what will run and the exact version, and need a yes.
- **Uncertainty never becomes `ignore`.** The local model never decides `urgent` and files only what it is confident of.

## What it does not guarantee

- **Message content is untrusted text, and your agent reads it.** Anyone who can message or email you can put
  instructions in front of your agent. Clockwork returns content as data and its skill file tells the agent to treat it
  that way, but Clockwork cannot control what the agent does next. Do not connect an agent that can send messages, run
  commands or spend money without asking you first. Clockwork's guarantees end where your agent begins.
- **Where your agent's model runs.** If the agent uses a cloud model, the content it reads goes to that provider.
- **Added extractors.** One can read your files, your other sessions and the network. Only add code you would run anyway.
- **Your accounts.** WhatsApp and X may restrict accounts read this way. See the README.

## In scope

Reading or changing data with the wrong token or no token; a listener reachable from another machine by default; an
extractor manifest that gains more than the documented environment; an install or update of outside code without
consent; any path that sends on the user's behalf; secrets written to logs or printed.

## Out of scope

Anything that needs your user account, the admin token or an extractor you added yourself; prompt injection of an agent
through message content (this is the documented limit above, though ideas that reduce it are welcome as issues);
platform account restrictions; exposure caused by a public address you configured.
