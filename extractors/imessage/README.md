# iMessage and SMS

Brings the texts in the Messages app on this Mac into Clockwork: iMessage, and SMS/RCS if your iPhone forwards them to
the Mac. macOS only.

**Read this before switching it on.** It copies your texts into Clockwork's own database on this Mac, where the local
model and your agent can read them. That includes private conversations and **verification codes** that banks and other
services text you. And it only works if you give **Full Disk Access** to the program that runs Clockwork, which is a
broad permission: that program (and anything else it runs) can then read almost every file in your account, not only
Messages. If either of those is more than you want, do not switch this on.

## What it reads

The file `~/Library/Messages/chat.db`, where Messages keeps its history. It is opened for reading only; nothing is
written to it, and nothing is ever sent, answered, reacted to or marked as read. It reads:

- the text of each message, who sent it (their phone number or email address, as Messages stores it), when, and in
  which conversation;
- for a group, its name and the numbers of the people in it;
- for a message that is only a photo, video, voice message or file: what kind it is. The file itself is never opened.

It does not read your Contacts, so people are shown by number or address, not by name. Tapbacks (the heart, thumbs-up
and so on) are left out.

## Setting it up

1. Give Full Disk Access to the program that runs Clockwork. Open **System Settings > Privacy & Security > Full Disk
   Access**, press **+**, and add the terminal app you start Clockwork from (Terminal, iTerm, ...). If Clockwork is
   started some other way, add `node` instead. You have to do this yourself; Clockwork cannot and does not try to.
   Quit and reopen that terminal afterwards.
2. Run `clockwork connect imessage`. This is the moment you say yes: until you have run it, the extractor does not
   open the Messages database at all (`clockwork check imessage` does not either).
3. `clockwork status` should show `imessage` as `ok` within a minute. If it shows `needs_login`, macOS is still
   refusing access: go back to step 1.

To stop: `clockwork disable imessage`, and take the program out of the Full Disk Access list again if nothing else
needs it. To make it forget that you said yes, delete the file `enabled` in its data folder.

## What it brings in, and when

The first time, the last 24 hours of messages, marked as history. After that it looks every 30 seconds for messages
newer than the last one it saw. Messages you sent are brought in too, as context; Clockwork never triages those.

## Hosts it contacts

None. It reads one file on this Mac and talks to Clockwork on this Mac (`127.0.0.1`).

## What it stores, and where

In its own data folder (`extractors/imessage` inside Clockwork's data folder): `enabled`, the note that you switched
it on, and `state.json`, which holds only the number of the last message it has seen. No message text is kept there.
The messages themselves go into Clockwork's database like every other source.

## Limits

- People are shown by number or address, never by name.
- A message that is edited or unsent after it was read is not updated in Clockwork.
- Newer versions of macOS store the text of many messages in a packed form instead of plain text. The extractor
  unpacks the common shape of it. A message it cannot unpack with certainty is skipped, and counted in its log
  (`skipped (no readable content)`), rather than passed on as nonsense. If you see many skipped, please report it.
- Only messages that reach this Mac are seen. SMS needs "Text Message Forwarding" switched on on your iPhone.
- Apple does not document this database and may change it in any macOS update. The reader was written from public
  descriptions of its layout and tested against a made-up database, not against a real one.
- Photos, videos and voice messages are noted but not read.

## Risks

- Your texts, including one-time codes and anything else people send you, end up in a second place on this Mac, and
  in front of your agent. Anyone or anything that can read Clockwork's data folder can read them.
- Full Disk Access is given to a whole program, not to this extractor. Every other thing that program runs gets it
  too.
- Clockwork cannot send a text, so a mistake here cannot message anyone. It can only read too much.
