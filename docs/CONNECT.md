# Connecting your agent

Clockwork needs an agent to teach it. This page says what any agent needs, then gives the steps for specific ones.

## What every agent needs

1. **The MCP server.** Run `clockwork agent`. It prints the address (`http://127.0.0.1:4600/mcp`), the file that holds
   the agent's token (`~/.clockwork/v2/agent-token`) and the skill file. The agent sends the token as
   `Authorization: Bearer <contents of the token file>`. Never paste the token into a chat; point the agent at the file.
2. **The skill.** [agent/SKILL.md](../agent/SKILL.md) tells the agent what the labels mean, what to do on each check,
   and what it must never do (follow instructions found inside a message, or send anything). Install the `agent/`
   folder the way your agent installs skills, under the name `clockwork`.
3. **A recurring check.** Every 10 to 15 minutes the agent calls `get_items_to_label`, judges each item and answers
   with `submit_labels`. Without a schedule nothing gets labelled and the local model never learns.
4. **Optional: wake-ups.** An agent that can receive webhooks can subscribe to two MCP events instead of waiting for
   its next check: `urgent_item` (an item was filed as urgent) and `heads_up_item` (an item matched one of the agent's
   own heads-up rules, or the local model thinks it may need attention). Both carry only an item id; the agent reads
   the item over MCP. Agents that cannot receive webhooks poll `get_urgent_updates` and `get_heads_up_updates`.

To check the connection, ask the agent to call `get_source_health`.

## Agents on the same machine, and agents somewhere else

An agent that runs **on the same machine** as Clockwork (OpenClaw, Hermes Agent) uses the local address and the token
file. Nothing is exposed, and you can skip the rest of this section.

Most hosted agents run **in their vendor's cloud** (ChatGPT dots, Grok Bot, Claude Duet). They cannot reach
`127.0.0.1`, and installing a plugin or MCP server in the vendor's desktop app does not change that: the agent still
runs in the cloud and only sees servers the cloud can reach. For these there are two ways to run Clockwork.

### Keep Clockwork on your machine and put a tunnel in front of it

This is the usual choice. Your messages stay on your disk; a tunnel program on your machine gives Clockwork a public
https address and forwards to it.

1. **Start a tunnel** that forwards to `http://127.0.0.1:4600`.
   - [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) gives a stable address and needs only a free Tailscale
     account: `tailscale funnel 4600`.
   - A [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
     needs no account and is good for trying things out: `cloudflared tunnel --url http://127.0.0.1:4600`. Its address
     changes every time it restarts, so the agent has to be reconnected each time.
   - Any other tunnel or reverse proxy that ends in https works too.
2. **Tell Clockwork its address.** Put it in `~/.clockwork/v2/config.json` as `"publicUrl": "https://..."`, then run
   `clockwork stop` and `clockwork start`. This switches on Clockwork's own sign-in page.
3. **Connect the agent** to `<your address>/mcp`, as described for your agent below. An agent that signs in with OAuth
   opens an approval page served by your own Clockwork; you approve it with the admin token from the same config file.
   Nobody else can: without that token every request except a bare health check is refused, and five wrong tries lock
   the page for a while.

What you are accepting: your message queue is now behind a login on the internet, and the tunnel provider carries the
traffic. The machine has to stay on and awake.

### Or run all of Clockwork on a remote machine

Clockwork also runs as one container on a server (see "Run in the cloud" in [REFERENCE.md](REFERENCE.md)). The agent
connects to the server's address the same way. Two things to know first:

- **Your messages and account sessions then live on that server,** not on your own disk.
- **Not every source works from a server.** Anything that needs a browser you log in to yourself (X) is awkward on a
  machine with no screen and may be challenged more often from a data-centre address. iMessage only works on your own
  Mac. Sources read through an API with a key (Gmail, Slack, GitHub and the like) and WhatsApp work the same anywhere.

## Which agents have been tried

| Agent | Where it runs | How it reaches Clockwork | Tried with Clockwork |
|---|---|---|---|
| [OpenClaw](#openclaw) | your machine | local address, token header | not yet |
| [Hermes Agent](#hermes-agent) | your machine | local address, token header | not yet |
| [ChatGPT dots](#chatgpt-dots) | OpenAI's cloud | public address, OAuth | yes: through a tunnel to a Mac, and on a remote machine |
| [Grok Bot](#grok-bot) | xAI's cloud | public address, token header | not yet |
| [Claude Duet](#claude-duet) | Anthropic's cloud | public address, token header | reading works; event wake-ups do not yet |

**Only the ChatGPT dot route has been run end to end** (reading, labelling and event wake-ups, both through a quick
tunnel to Clockwork on a Mac and against a remote machine). Claude Duet has been connected and can read from
Clockwork, but getting it to subscribe to events is not solved yet. The other three (OpenClaw, Hermes Agent,
Grok Bot) are written from each product's own documentation as of November 2026 and have not been tried against
Clockwork. If a step is wrong, please open an issue.

In the snippets below, `clockwork` is the name given to the MCP server, and `<token>` stands for the contents of
`~/.clockwork/v2/agent-token`.

## OpenClaw

Runs on your machine, so it uses the local address.

1. **MCP server.** Add it to `~/.openclaw/openclaw.json`. Set `transport`, because OpenClaw assumes `sse` when it is
   left out:

   ```json5
   { mcp: { servers: { clockwork: {
     url: "http://127.0.0.1:4600/mcp",
     transport: "streamable-http",
     headers: { Authorization: "Bearer ${CLOCKWORK_AGENT_TOKEN}" }
   } } } }
   ```

   OpenClaw fills `${...}` from its environment, so the token itself stays out of the config file: set
   `CLOCKWORK_AGENT_TOKEN` to the contents of the token file in the environment OpenClaw runs with. Check it with
   `openclaw mcp doctor --probe`.
2. **Skill.** Copy this repository's `agent/` folder to `~/.openclaw/skills/clockwork` (or your workspace's `skills/`).
3. **Recurring check.**

   ```bash
   openclaw automations create "every 15m" "Use the clockwork skill: label what is waiting and tell me about anything urgent." --name clockwork
   ```
4. **Wake-ups (optional, untested).** OpenClaw's bundled `mcp-events` plugin subscribes to MCP events, but it needs a
   public https address for the callbacks (`callbackOrigin`), and Clockwork only delivers to public https addresses.
   Without one, the recurring check is enough. See OpenClaw's
   [MCP events page](https://docs.openclaw.ai/automation/mcp-events).

OpenClaw's docs: [MCP servers](https://docs.openclaw.ai/cli/mcp/transports), [skills](https://docs.openclaw.ai/tools/skills),
[automations](https://docs.openclaw.ai/cli/cron).

## Hermes Agent

Runs on your machine or server, so it uses the local address when it is on the same machine as Clockwork.

1. **MCP server.** In `~/.hermes/config.yaml`:

   ```yaml
   mcp_servers:
     clockwork:
       url: "http://127.0.0.1:4600/mcp"
       headers:
         Authorization: "Bearer ${CLOCKWORK_AGENT_TOKEN}"
   ```

   Hermes fills `${...}` from its environment, including `~/.hermes/.env`: add a line `CLOCKWORK_AGENT_TOKEN=` followed
   by the contents of the token file there. Check it with `hermes mcp test clockwork`.
2. **Skill.** Copy this repository's `agent/` folder to `~/.hermes/skills/clockwork`.
3. **Recurring check.**

   ```bash
   hermes cron create "every 15m" "Label what is waiting in Clockwork and tell me about anything urgent." --skill clockwork
   ```
4. **Wake-ups (optional, untested).** Hermes has experimental MCP event support (`events: true` on the server entry,
   plus its webhook platform with a public https address). It follows the MCP working group's draft, and Clockwork
   follows OpenAI's MCP Events guide, so the two may not match yet. See Hermes's
   [MCP page](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).

Hermes's docs: [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp),
[skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills),
[cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

## ChatGPT dots

A dot runs in OpenAI's cloud, so Clockwork needs a public address first (see above). ChatGPT signs in with OAuth.
Uploading a plugin archive or adding a local MCP server in the ChatGPT desktop app does not work for a dot: those only
reach chats that run on your own computer.

1. **MCP server.** In ChatGPT open [Plugins](https://chatgpt.com/plugins), choose the plus button, then **Add custom
   MCP server**. Enter your public address ending in `/mcp` and set authentication to OAuth. ChatGPT opens an approval
   page served by your own Clockwork; approve it with the admin token from `~/.clockwork/v2/config.json`.
2. **Skill.** Give the dot the contents of [agent/SKILL.md](../agent/SKILL.md) and ask it to keep them as its standing
   instructions for Clockwork. It reaches Clockwork at your public address, not `127.0.0.1`, and it has no token file:
   the OAuth sign-in replaces it.
3. **Recurring check.** Ask the dot in chat, for example: "Every 15 minutes, label what is waiting in Clockwork and
   message me about anything urgent." It appears under **Scheduled**.
4. **Wake-ups.** Ask the dot to respond to Clockwork's `urgent_item` and `heads_up_item` events. It subscribes by
   itself and Clockwork calls it when one fires. You can see its subscriptions at `GET /subscriptions` with the admin
   token.

OpenAI's docs: [dots](https://learn.chatgpt.com/docs/dots),
[connecting an MCP server](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[MCP Events](https://developers.openai.com/plugins/build/mcp-events).

## Grok Bot

A Bot runs on xAI's cloud computer and cannot reach your machine's local address, so Clockwork needs a public address
first (see above).

1. **MCP server.** In **Connect apps** choose **Add a custom connector**, type **Remote HTTPS**. Enter your public
   address ending in `/mcp` as the server URL and add the HTTP header `Authorization: Bearer <token>`. Use the header,
   not OAuth: Clockwork's OAuth sign-in only sends approved connections back to ChatGPT unless you add Grok's callback
   address to `CLOCKWORK_OAUTH_REDIRECTS`.
2. **Skill.** Give the Bot the contents of [agent/SKILL.md](../agent/SKILL.md) and ask it to save them as a skill
   called `clockwork`.
3. **Recurring check.** Ask the Bot in chat, for example "every 15 minutes"; it creates a routine. Routines must be at
   least five minutes apart.
4. **Wake-ups (untested).** Grok Bot does not document MCP event subscriptions. A routine can have a webhook trigger
   with its own address and key, and Clockwork's push alert for urgent items can call an https address
   (`CLOCKWORK_URGENT_WEBHOOK_URL`), but Clockwork signs its calls and does not send the bearer key Grok expects, so
   this does not work as it stands. Use the recurring check.

xAI's docs: [apps and connectors](https://docs.x.ai/grok-bot/computer-and-apps),
[skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).

## Claude Duet

Duet runs on Anthropic's cloud and uses the connectors and skills of your Claude account. Clockwork needs a public
address first (see above), and it must be on the standard https port.

1. **MCP server.** In Claude go to **Customize > Connectors**, **Add custom connector**. Enter your public address
   ending in `/mcp`, and under **Request headers** add `Authorization: Bearer <token>`. Use the header, not OAuth, for
   the same reason as Grok Bot.
2. **Skill.** Zip this repository's `agent/` folder, renamed `clockwork`, and upload it in **Customize > Skills**.
3. **Recurring check.** Duet checks on its own schedule and lets you say what you want to hear about and how often;
   it does not document a way to set an exact interval. Ask it to label what is waiting in Clockwork at each check.
4. **Wake-ups. Not solved yet.** Duet connects and reads from Clockwork, but we have not got it to subscribe to
   Clockwork's events, so it is not woken for urgent items or heads-ups. Until that works it only sees new items at
   its own checks. If you find a way, please open an issue.

Anthropic's docs: [Claude Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet),
[custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
[custom skills](https://support.claude.com/en/articles/12512198-how-to-create-custom-skills).

## Any other agent

Anything that can add an MCP server reached over HTTP with a bearer header, load a page of instructions, and run a
task on a schedule will work. Give it the three things at the top of this page. If your agent cannot send a fixed
header, use the OAuth route above. If you get one working that is not listed here, a pull request adding its steps is
welcome.
