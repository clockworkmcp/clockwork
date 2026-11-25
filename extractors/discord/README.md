# Discord

Brings messages from Discord servers into Clockwork, through a **bot that you create** and add to servers you run or are
allowed to add bots to. It uses Discord's official API and only ever reads.

## What it reads, and what it cannot

- It reads new messages in the text and announcement channels the bot can see, in every server the bot has been added to.
  The first time it sees a channel it brings in the last 24 hours, marked as history.
- **It cannot read your direct messages**, group chats, or any server the bot is not in. A bot is its own account, not you.
- It does not read threads, forum posts or voice-channel chat (not yet).
- It does not use your personal account's token (a "self-bot"). That is against Discord's terms and gets accounts
  banned. Never give it your own account's token. If you want a server's messages and cannot add a bot
  to it, this extractor cannot help.

It never sends a message, adds a reaction or marks anything as read: every request it makes is a read (`GET`), and the
bot is given no permission to post. It does not connect to Discord's live gateway, so the bot always shows as offline.

## Set it up

1. Open <https://discord.com/developers/applications>, choose **New Application** and give it a name.
2. On the **Bot** page:
   - switch **Message Content Intent** on (under "Privileged Gateway Intents"). Without it Discord sends the bot
     messages with their text removed, and Clockwork will report `needs_intent`;
   - switch **Public Bot** off, so nobody else can add your bot anywhere;
   - choose **Reset Token** and copy the token. It is shown once.
3. Add the bot to a server. You need the "Manage Server" permission there. Open this address in your browser, with
   your application's id (on the **General Information** page) in place of `APPLICATION_ID`:

   ```
   https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot&permissions=66560
   ```

   `66560` is exactly two permissions: **View Channels** and **Read Message History**. Do not give it more.
4. Run `clockwork connect discord` in your own terminal and paste the token when asked; nothing is shown as you paste.
   Clockwork keeps it in your macOS Keychain, not in a file (on a machine with no keychain, in a file only you can
   read).
5. `clockwork connect discord`, then `clockwork status`.

Private channels: the bot sees a private channel only if you add the bot (or its role) to that channel in Discord.
Channels it may not read are skipped quietly and tried again an hour later.

### Optional files, in the same folder

- `channels.txt`: one channel id per line (`#` starts a comment). When it exists, only those channels are read.
  To copy a channel id: Discord settings, Advanced, Developer Mode on; then right-click the channel, "Copy Channel ID".
- `me`: your own Discord user id (right-click your name, "Copy User ID"). Mentions of you then read `@Name (you)`,
  and messages you wrote are filed as your own (outgoing), which Clockwork uses as context and never triages.

## What an item looks like

Mentions, channel links and custom emoji are turned into plain text: `<@123>` becomes `@Dana`, `<#456>` becomes
`#general`, `<:party:789>` becomes `:party:`. A message with only a file is filed as `image`, `video`, `audio` or
`document` with no text. Join notices, pins and other system messages are left out.

## What it contacts

- `discord.com` (`https://discord.com/api/v10`): three read-only addresses, `GET /users/@me/guilds`,
  `GET /guilds/{id}/channels` and `GET /channels/{id}/messages`.
- Clockwork on this machine (`127.0.0.1`).

Nothing else. No attachments are downloaded.

## What it stores, and where

In the extractor's private folder (`~/.clockwork/v2/extractor-data/discord/`):

- `state.json`: for each channel, the id of the last message read. No message text.
- `channels.txt` and `me`, if you made them.

The messages themselves go to Clockwork's own database on this machine.

## Limits and pace

- It waits a second before every request, looks at each channel once a minute, and obeys Discord's rate limits: it does
  not use a route that has no requests left until it refills, and after a "too many requests" answer it waits exactly
  as long as Discord says (for everything, when Discord says the limit is global).
- At most 500 new messages per channel per pass; a busier channel catches up over the following passes.
- With very many channels a pass takes about a second per channel. Use `channels.txt` to keep to the ones that matter.
- Edits to and deletions of messages already read are not picked up.

## The risk

The bot token lets its holder read every channel the bot can see. Keep it to yourself, and if it leaks, choose
**Reset Token** in the Developer Portal. Other members of a server can see that a bot is present; add it only where
you run the server or its owners agree, and remember that their messages are copied to this machine and shown to your
agent. To stop: `clockwork disable discord`, and remove the bot from the server.
