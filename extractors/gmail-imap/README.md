# Gmail with an app password

Brings your Gmail into Clockwork over IMAP, signing in with an app password. It is the quick way to connect Gmail:
there is no Google Cloud project to create and no browser step. The other way is the [`gmail`](../gmail/extractor.json)
extractor, which uses Google's API and can be limited to reading. **Use one of the two, not both.** They read the same
mail and give each message the same id, so switching from one to the other brings nothing in twice and keeps what the
local model has learned.

> **Not yet run against a real Gmail account.** It has only met a stand-in mail server in its tests. Expect to find
> problems the first time, and please report them.

It only reads. It never sends, moves, deletes, labels or archives mail, and it never marks a message as read: your
unread count in Gmail stays exactly as it was.

## Set it up

1. Your Google account needs **2-Step Verification**. Then open <https://myaccount.google.com/apppasswords>, make an
   app password, and name it "clockwork".
2. Google shows sixteen letters once. Save them in `~/.clockwork/v2/extractor-data/gmail-imap/login.json`:

   ```json
   { "address": "you@gmail.com", "appPassword": "abcd efgh ijkl mnop" }
   ```

   Keep the file to yourself: `chmod 600` it. **Never put your normal Google password in this file.** The program
   refuses anything that is not shaped like an app password and sends it nowhere.
3. Run `clockwork connect gmail-imap`. It signs in once and tells you which folder it will read.

Google does not offer app passwords for every account: not with Advanced Protection, not where only security keys are
allowed, and not where a work or school administrator has switched them off. Use the `gmail` extractor for those.

## Permission: read this before you choose it

**An app password is not limited to reading, and not limited to mail.** Anyone who holds it can read, send and delete
your mail and reach other parts of your Google account that accept app passwords, without your second step. Google has
no read-only kind. What keeps this read-only is the program itself:

- it opens your mailbox with `EXAMINE`, which Gmail itself treats as read-only for the whole session;
- it fetches mail with `BODY.PEEK`, which does not mark it as read;
- its mail client ([imap.mjs](imap.mjs)) can send six commands, all of which only read or sign in and out, and a test
  checks that nothing else is ever sent.

The app password sits in `login.json` on your disk, unencrypted, like the rest of Clockwork's data. If that worries you
more than fifteen minutes in the Google Cloud console, use the `gmail` extractor: its access is read-only at Google's
end. You can take an app password back at any time on the same Google page, and Google removes all of them when you
change your account password.

## What it reads

- Every message in **All Mail** that is not a draft, in spam or in the bin: what you receive, what you send (kept as
  context, never triaged) and what a filter archived. If you have hidden All Mail from IMAP in Gmail's settings, only
  the inbox is read, and `clockwork connect` says so.
- On the first run, the last three days, marked as history. After that, only mail that is new since the last look,
  once a minute.
- Of each message: sender, recipients, subject, the text (the plain part, or the HTML part turned into text), how many
  attachments it has, its Gmail labels and inbox category. Only the first 256 KB of a message is downloaded, so
  attachments are counted and never fetched.

## What it contacts

- `imap.gmail.com` on port 993, over TLS, checked against Google's certificate. Nothing else on the internet.
- Clockwork on this machine, with a token that can only add items.

## What it stores

In `~/.clockwork/v2/extractor-data/gmail-imap/`: `login.json` (yours) and `state.json` (which folder, and the number of
the last message read). No mail is kept there; items go to Clockwork's own database.

## Settings

Environment variables, for the rare case you need them: `CLOCKWORK_GMAIL_IMAP_REST_SECONDS` (pause between looks,
default 60) and `CLOCKWORK_GMAIL_IMAP_FIRST_DAYS` (history on the first run, default 3).

## Tests

```bash
node --test extractors/gmail-imap/gmail-imap.test.mjs
```

They run against a stand-in mail server on this machine with made-up mail. `clockwork check gmail-imap` also runs the
program over the sample mail in [fixtures/](fixtures/), whole and damaged.
