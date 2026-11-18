# Linear

Brings the notifications from your Linear inbox into Clockwork: an issue assigned to you, a mention, a new comment, a
status change, a project update. Each notification becomes one item, filed under the issue it is about.

It only reads. It never marks a notification as read, archives it or snoozes it, so your Linear inbox looks exactly as it
did before.

## Set it up

1. In Linear, open **Settings > Account > Security & Access** and create a **personal API key**.
2. When asked what the key may do, choose **Read** only. Do not give it Write, Admin, Create issues or Create comments.
   You can also limit the key to some teams if you like.
3. Save the key (it starts with `lin_api_`) as the only line of a file named `token` in this extractor's private folder:
   `~/.clockwork/v2/extractor-data/linear/token` unless you moved Clockwork's data. `clockwork connect linear` tells you
   the exact place if the file is missing.
4. Run `clockwork check linear`, then `clockwork enable linear`.

If your workspace does not let members create API keys, an admin has to allow it first.

## Permission needed

A personal API key with **Read**. Nothing else. With a Read-only key Linear itself refuses any change, whatever a program
asks for. This extractor does not ask for one in the first place: the single request it knows is a question (a GraphQL
`query`), and it refuses to send anything else.

## What it contacts

- `https://api.linear.app/graphql` (Linear's API), with your key.
- Clockwork on this machine (`127.0.0.1`), to hand over the items.

Nothing else.

## What it stores, and where

In its private folder only:

- `token`: the key you saved.
- `state.json`: the time of the newest notification it has seen and the ids of the last few hundred, so nothing is
  brought in twice. No message text.

The notifications themselves (who, which issue, the comment text) go into Clockwork's own store on this machine.

## Limits

- It looks at the inbox every two minutes, with a pause before each request, and waits when Linear says to slow down.
- The first run brings in the last 24 hours, marked as history. After that, only what is new.
- It reads at most 300 notifications per look. If more than that arrive between two looks, the oldest are missed.
- Issue and project notifications come with their title, comment text and link. Other kinds (documents, initiatives,
  customer requests, pull request reviews and so on) arrive with their type and sender only.
- Notifications you archived in Linear are not read. Ones you already read or snoozed in Linear still come in.
- It works with a personal API key, not with an OAuth app's token.

## The risk

This is almost always a work account. Issue titles and comments are your employer's information, and this copies them to
this machine and shows them to your agent. Whether that is allowed is your employer's decision, not yours and not
Clockwork's. Ask first if you are not sure. To stop, run `clockwork disable linear`, delete the `token` file, and revoke
the key in Linear's settings.
