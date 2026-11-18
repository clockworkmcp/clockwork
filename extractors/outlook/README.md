# Outlook

Brings new mail from the inbox of an Outlook.com or Microsoft 365 account into Clockwork, through Microsoft's own API
(Microsoft Graph), read-only.

## What it reads, and what it cannot do

- New mail arriving in your **Inbox**. The first run brings in the last 24 hours, marked as history.
- For each message: sender, subject, the text of the body (up to 6,000 characters), when it arrived, its conversation,
  and a link that opens it in Outlook on the web. Attachments are not downloaded; an item only notes that there are some.
- It does not read other folders (Sent, Archive, Junk, folders your rules move mail into).
- It cannot mark as read, move, delete or send. The only permission it asks Microsoft for is `Mail.Read`, which does
  not allow any of that, and the program only ever sends read requests (`GET`) to Graph.

## Set it up

You register a small application of your own with Microsoft, so that the access belongs to you and nobody else.
There is no password and no secret to keep for it.

1. Open <https://entra.microsoft.com>, go to **App registrations** and choose **New registration**.
   - Name: anything, for example "Clockwork mail reader".
   - Supported account types: choose the kind of account your mailbox is (see `tenant` below).
   - Redirect URI: leave empty.
2. On the application's **Authentication** page, under "Advanced settings", set **Allow public client flows** to
   **Yes** and save. (This is what lets you sign in with a code instead of a web page on this machine.)
3. On **API permissions**: **Add a permission**, **Microsoft Graph**, **Delegated permissions**, and tick
   `Mail.Read` and `offline_access`. Nothing else is needed; you can remove `User.Read` if it was added for you.
   Do not add `Mail.ReadWrite` or `Mail.Send`.
4. Copy the **Application (client) ID** from the **Overview** page and save it in the extractor's private folder:

   ```bash
   mkdir -p ~/.clockwork/v2/extractor-data/outlook && chmod 700 ~/.clockwork/v2/extractor-data/outlook
   echo '{ "clientId": "PASTE-THE-ID-HERE", "tenant": "common" }' > ~/.clockwork/v2/extractor-data/outlook/client.json
   ```

   `tenant` says which accounts may sign in, and must fit what you chose in step 1:
   `"consumers"` for a personal account (outlook.com, hotmail.com, live.com), `"organizations"` for a work or school
   account, `"common"` for either, or your organisation's tenant id when the application is for one organisation only.
5. Run `clockwork connect outlook`. It shows an address and a short code. Open the address in your browser, enter the
   code, sign in, and approve "Read your mail" and "Maintain access to data you have given it access to".
6. `clockwork status`.

Optional: a file named `me` in the same folder with your own address (or several, one per line). Mail from those
addresses is then filed as your own (outgoing), which Clockwork keeps as context and never triages.

## What it contacts

- `login.microsoftonline.com`: to sign in and to renew the sign-in
  (`/{tenant}/oauth2/v2.0/devicecode` and `/{tenant}/oauth2/v2.0/token`).
- `graph.microsoft.com`: one read-only address, `GET /v1.0/me/mailFolders/inbox/messages/delta`.
- Clockwork on this machine (`127.0.0.1`).

Nothing else.

## What it stores, and where

In the extractor's private folder (`~/.clockwork/v2/extractor-data/outlook/`):

- `client.json`: the application id and tenant, which you put there. Not a secret.
- `token.json`: the saved sign-in (a "refresh token"), readable only by you. **Treat it like a password**: whoever has
  it can read your mail until you withdraw it. It is never printed or logged.
- `state.json`: where it had got to in the inbox (a link from Microsoft and two dates). No mail.

The mail itself goes to Clockwork's own database on this machine.

## Limits and pace

- It looks at the inbox every two minutes and asks only for what changed since last time. When Microsoft says "slow
  down" it waits as long as it is told.
- Up to 2,000 messages per pass; a larger backlog arrives over the following passes.
- If the sign-in stops working (you changed your password, an administrator withdrew it, or it went unused for about
  90 days), Clockwork shows `needs_login`. Run `clockwork connect outlook` again.
- Mail that a rule moves out of the inbox before the next look may be missed.
- If Microsoft changes how a message is filed (for example it is read on another device) it may be offered to
  Clockwork again; it is stored once.

## The risk

- **A work or school mailbox is your employer's.** Many organisations do not let people register applications or approve
  them for themselves, so an administrator may have to allow this one ("admin consent"). Whether work mail may be copied
  to this machine and shown to your agent at all is your employer's decision, not a technical one. Ask first.
- Everything in your inbox that arrives from now on is copied to this machine and can be read by the agent you connect
  to Clockwork, including password-reset links and one-time codes sent by mail.
- To withdraw access: `clockwork disable outlook`, delete `token.json`, and remove the application's access at
  <https://myapps.microsoft.com> (work or school) or <https://account.microsoft.com/privacy/app-access> (personal). You
  can also delete the app registration.
