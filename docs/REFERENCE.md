# Reference

How the parts work, the access tokens, the single-container cloud setup, alerts and OAuth. For a normal install on your own
machine start with [LOCAL.md](LOCAL.md).

## How an item is decided

1. **Rules** drop your own messages, promoted posts and contentless events.
2. **Student** (small local embedding model + a head trained on your labels) decides only when it is confident,
   the source is one it was trained on, and there is no sign of urgency.
3. **Teacher** (Claude, with your `policy.md`) decides everything else. Each answer is stored as a training label.
4. With no teacher reachable, the item is held as `later`. Uncertainty never becomes `ignore`.

Corrections sent through `record_feedback` outrank teacher labels at the next retrain.

## Layout

- `cli/` the `clockwork` command and the local supervisor (`clockwork run`). `extractors/` manifests for the built-in extractors and the template.

- `core/` Node service: SQLite store, ingest, cascade, HTTP + MCP (`POST /mcp`). `npm test` runs the tests.
- `student/` Python scorer (`serve.py`) and trainer (`train.py`, promotes a new head only if it does not regress).
- `connectors/whatsapp/` Go companion-device worker; read-only; QR link page on port 4599.
- `connectors/gmail/` Node worker: read-only Gmail API, incremental sync by history id. Run `node main.mjs auth` once, then `node main.mjs`.
- `connectors/x-cloud/` optional: a browser on the instance itself that reads the X home timeline on a schedule (see below).

## Run locally

```bash
cd core && npm install && node server.mjs            # http://127.0.0.1:4600, no token needed on loopback
cd student && python serve.py                         # http://127.0.0.1:4601
cd connectors/whatsapp && go build -o clockwork-whatsapp . && ./clockwork-whatsapp
```

Data lives in `~/.clockwork/v2/` (`CLOCKWORK_DATA` overrides it). With no `CLOCKWORK_TOKEN` set, the core listens on loopback only and needs no token. The teacher turns on when Anthropic credentials are
present (`ANTHROPIC_API_KEY` or an `ant auth login` profile). `CLOCKWORK_TEACHER_MODEL` picks the model
(default `claude-opus-5-5`; `claude-haiku-5-5` is the low-cost setting). `CLOCKWORK_TEACHER=off` disables it.

## Access tokens

Three bearer tokens with separate powers, so each client gets the least it needs:

| Variable | Holder | Can do |
|---|---|---|
| `CLOCKWORK_TOKEN` | you (admin) | everything, and is the password for the WhatsApp link page |
| `CLOCKWORK_AGENT_TOKEN` | your AI agent | `POST /mcp` only. Its corrections are stored as `agent` labels and it cannot mark items `ignore` |
| `CLOCKWORK_INGEST_TOKEN` | extractors | `POST /ingest/*` only: write, never read |

Item text, sender names and URLs returned by the MCP tools are untrusted third-party content. Do not connect this
MCP endpoint to an agent that can send messages or post on your behalf without asking you first.

## Run in the cloud

One image holds a whole instance (`Dockerfile`), with all private data in `/data`. Processes run as an unprivileged
user. A new machine waits for `/data/.seeded` before starting anything, so existing data can be uploaded safely;
set `CLOCKWORK_FRESH=1` for a brand-new user.

On Fly.io, one app per user, each on its own private network:

```bash
fly apps create clockwork-<user> --network clockwork-<user>
fly volumes create clockwork_data --app clockwork-<user> --region fra --size 3 --yes
fly secrets import --app clockwork-<user> < secrets.env      # the three tokens and ANTHROPIC_API_KEY; never on the command line
fly deploy --app clockwork-<user> --ha=false                  # exactly one machine: two would fight over the WhatsApp session
fly proxy 4599 --app clockwork-<user>                         # then open http://127.0.0.1:4599 to link WhatsApp
```

The core is served over HTTPS at `https://clockwork-<user>.fly.dev`. Put that address plus the agent token in
your agent's MCP settings (`/mcp`). On any other Docker
host, `compose.yaml` runs the same parts as separate services with both ports bound to loopback.

## X capture from the instance (cloud browser)

Off by default; set `CLOCKWORK_X_CLOUD=1`. An ordinary Chromium on the instance, logged in to X by the owner, opens the
home timeline every `CLOCKWORK_X_INTERVAL_MIN` minutes (default 30, with jitter), reads a few screens of both home tabs and
forwards the timeline JSON the page fetched to `/ingest/x-raw`. The browser runs only during a
visit or a login. `GET /stats` shows its state under `xCloud`.

- **Logging in:** `POST /x-login` (admin) opens a 20-minute login window. Run `fly proxy 9223`, open `chrome://inspect` in
  your own Chrome, add `localhost:9223` under "Configure", and inspect the X login page to type into it. The window closes
  as soon as a session exists. The password is typed by the owner into X's own page; Clockwork never sees it.
- **Challenges:** if X asks for a check or sends the browser away from the home timeline, the connector reports `blocked`
  and waits two hours. It never answers a challenge. Open a login window to deal with it by hand.
- **Costs and risks:** X may restrict an account that is read from a datacenter on a schedule. More posts also means more
  items for the teacher. The session lives in `/data/x-cloud/profile` on the volume.

## Urgent alerts

- **Poll:** the MCP tool `get_urgent_updates` returns urgent items classified after a `cursor` and sent in the last 12 hours.
  Pass the returned cursor back next time and nothing is reported twice.
- **Push:** set `CLOCKWORK_URGENT_WEBHOOK_URL` (https) and `CLOCKWORK_WEBHOOK_SECRET`. When a recent item becomes urgent the
  core POSTs `{"type":"clockwork.urgent","ids":[...]}` with an `x-clockwork-signature: sha256=<HMAC of the body>` header.
  The push carries ids only; the receiver reads the items over MCP. Failed deliveries are retried with backoff.
- **MCP Events (ChatGPT dots and other agents that subscribe):** the MCP endpoint offers the event `urgent_item` (and
  `heads_up_item`, described under "Heads-ups" below) through
  `events/list`, `events/subscribe` and `events/unsubscribe`, following OpenAI's MCP Events guide. The agent supplies its own
  callback URL and `whsec_` secret; nothing is configured here. The callback is checked with a signed challenge before it is
  stored, must be a public https address, and redirects are not followed. Each urgent item is one POST
  `{eventId, name, timestamp, data: {id, source}, cursor}` signed the Standard Webhooks way; failures are retried with backoff
  and a subscription only ever gets an item once it is past its cursor. Items the agent itself labelled urgent are not sent
  back to it. Subscriptions live in the database (30 days unless the agent asks otherwise; it refreshes them). The admin can
  see them at `GET /subscriptions` and cut one off with `POST /subscriptions/remove {id}`. Code: `core/events.mjs`.

## Connecting an agent that signs in with OAuth (ChatGPT)

ChatGPT's "Add custom MCP server" screen cannot send a fixed token, so the core is also a small OAuth server
(`core/oauth.mjs`). Set `CLOCKWORK_PUBLIC_URL` to the instance's public https address to switch it on. The owner then adds
`<address>/mcp` in ChatGPT with authentication set to OAuth, lands on an approval page served by the instance, and approves
by entering the admin token. The connected app gets the agent role (`POST /mcp` only), the same as `CLOCKWORK_AGENT_TOKEN`.

- Authorization code with PKCE (S256) only, public clients, one-hour access tokens, rotating 90-day refresh tokens; a
  refresh token used twice ends the connection. Tokens and codes are stored hashed.
- Approved connections can only be sent back to the addresses in `CLOCKWORK_OAUTH_REDIRECTS` (default: ChatGPT's two
  callback addresses). Clients register themselves (`/oauth/register`) or use a client-id URL on one of those origins.
- Five wrong admin tokens lock the approval page for a while.
- The admin sees connections at `GET /oauth-connections` and ends one with `POST /oauth-connections/revoke {id}` (no id: all).

Digests and queues are windowed and ordered by when an item was sent (`sentAt`), not when it was classified.

## The agent as teacher (shadow mode)

The user's own agent can be the teacher, so the instance needs no model key of its own. Set `CLOCKWORK_TEACHER_MODE=agent`.

- Everything the rules do not settle is held as `later` and listed for the agent. The local model predicts each item but decides nothing.
- The agent calls `get_items_to_label` on a schedule (every 10 to 15 minutes), judges each item with what it knows about the
  user, and answers with `submit_labels`. Likeliest-urgent items come first; raising urgent ones with the user is the agent's job.
- The trainer retrains daily on those labels, one model per source. A source needs `CLOCKWORK_MIN_LABELS` labels (default 200).
- A source leaves shadow mode by itself once at least 30 of the model's confident predictions have been checked by the agent and
  90% matched (`CLOCKWORK_GRADUATE_MIN`, `CLOCKWORK_GRADUATE_AGREEMENT`). From then on the model decides what it is sure of,
  the agent keeps labelling the rest, and a fifth of each labelling batch is a spot-check of the model's own decisions.
- `get_training_status` (or `GET /training`) shows progress. `POST /shadow {"source":"gmail","mode":"on|off|auto"}` overrides it.
- `GET /agent-ignores` lists what the agent filed under ignore, for the user's own spot-checks. As teacher the agent can mark
  items ignore, so only give the agent token to an agent you trust with that.
- `CLOCKWORK_AGENT_FALLBACK_MINUTES` (with a model key set) lets the built-in teacher take items the agent has left that long.

### Heads-ups: waking the agent for an item as it arrives

With the agent as teacher, items normally wait for its next scheduled check. A heads-up wakes it sooner for one item. It
is a wake-up for the agent, not a message to the user, and it never changes where the item is filed: the item still waits
as `later` until the agent labels it, and the agent decides whether the user needs to hear about it.

- **Why an item gets one:** one of the agent's heads-up rules matches it, or the local model's urgent detector thinks it may
  need attention. An item a rule matches is always left for the agent, even where the local model would otherwise file it.
- **When one is held back:** another item in the same conversation woke the agent in the last
  `CLOCKWORK_HEADSUP_GAP_MIN` minutes (default 60; a conversation is the chat or thread, or the sender where there is none);
  the message is older than `CLOCKWORK_URGENT_MAX_AGE_HOURS` (default 12); or the user has already written in that
  conversation since. The item is still waiting for a label either way.
- **Rules** are a list of `{ name, why?, ...conditions }`. Every condition given must hold: `source`, `isGroup`, `chats`
  (exact thread ids), `senders` (exact sender ids), `senderContains`, `anyWords`, `allWords`, `notWords` (text and subject,
  any case), `kinds`, `hours` (`[from, to]` in local whole hours, `to` not included, may wrap midnight, e.g. `[22, 7]`) and
  `days` (`"sun"` to `"sat"`). Local time is `CLOCKWORK_TZ`. A rule needs at least one condition; at most 200 rules.
- **Agent:** `get_heads_up_rules`, `set_heads_up_rules` (replaces the whole list), the MCP event `heads_up_item`
  (payload `{id}` only; items labelled before delivery are skipped) and the polling tool `get_heads_up_updates` with a cursor.
  **Admin:** `GET /heads-up-rules` and `PUT /heads-up-rules` with `{"rules": [...]}`.
- `get_quality` / `GET /quality` has a `headsUps` block: how many were raised, by rule or by the model, how many were labelled
  since, and how many of those were labelled urgent. Code: `core/headsup.mjs`.

With the built-in teacher still on, `CLOCKWORK_AGENT_TEACHER=1` gives the agent the same tools. Its queue is then the items the
built-in teacher was unsure about, plus spot-checks. Agent labels outrank the built-in teacher's in training.

Set `CLOCKWORK_TZ` (an IANA name such as `Europe/Paris`) so times written in messages are read in the user's timezone.

## Health, alert quality and thread context

- `GET /sources` (agent tool `get_source_health`): per source, when its connector last reported in, when the last new item arrived,
  how late items arrive (median and 90th percentile, last 24 hours), and what is still waiting. Connectors send a heartbeat even
  with nothing new (`POST /ingest/events` with an empty list and a `status`), so "connected, nothing new" is distinct from
  "not heard from". With several accounts on one source, a dead one is listed under `accountsNeedingAttention`.
- `GET /quality?days=30` (agent tool `get_quality`): alerts later upheld or lowered by the agent or the user, urgent items that were
  only raised afterwards, urgent items where the user wrote in the thread afterwards, and how often the local model was
  right where it was confident.
- An urgent item where the user wrote in the same thread afterwards is still alerted, marked `youWroteInThreadAfter` (in lists and in
  the event itself). A later message is not proof the matter is settled, so nothing is held back on it: `get_event` and the labelling
  queue include `laterInThread` for the agent to judge.
- Items carry `chat` (a WhatsApp group's title), `url` (the post, the mail thread, or the one-to-one WhatsApp chat) and
  `unseenMedia` when a picture, video, voice note or file arrived without a caption. The local model never files those alone.

## Operating notes

- The teacher is capped at `CLOCKWORK_TEACHER_DAILY_ITEMS` labels per day (default 3000). Over the cap, items are held as `later`.
- `POST /audit {"n": 40}` has the teacher re-check a random sample of the student's own decisions.
- The database, WhatsApp session and Gmail token are stored unencrypted on the volume. Anyone with access to the hosting
  account can read them, and message text is sent to Anthropic when the teacher is consulted.
- Events are never pruned yet, so watch the volume size.

## Not built yet

Fine-tuned student encoder, X capture while you are not browsing, onboarding page, data pruning,
encryption at rest beyond the host's disk, a Gmail authorization flow that works without a local browser.
