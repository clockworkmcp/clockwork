# Bluesky

Brings your Bluesky notifications into Clockwork: **replies** to you, **mentions** of you and **quotes** of your posts.
Likes, reposts, follows and every other kind of notification are skipped, because they rarely need an answer.

It only reads. It never posts, replies, likes, reposts or follows, and it never marks a notification as read: your
unread count in Bluesky stays exactly as it was.

## Set it up

1. In Bluesky, open **Settings**, then **Privacy and security**, then **App passwords**, and add one. Give it a name
   such as "clockwork". Leave **"Allow access to your direct messages"** switched off: this program does not read
   direct messages and should not be able to.
2. Bluesky shows the app password once. It looks like `abcd-efgh-ijkl-mnop`. Save it in
   `~/.clockwork/v2/extractor-data/bluesky/login.json`:

   ```json
   { "handle": "you.bsky.social", "appPassword": "abcd-efgh-ijkl-mnop" }
   ```

   Keep the file to yourself: `chmod 600` it. **Never put your main Bluesky password in this file.** The program
   refuses anything that does not look like an app password and sends it nowhere.
3. Run `clockwork connect bluesky`.

If your account lives on another server than Bluesky's own, add its address: `"service": "https://pds.example"`.

To also bring in your home timeline (posts from the people you follow), add `"timeline": true` to the file. It is off
by default: a timeline is a lot of items that are not addressed to you.

## Permission

An app password can do most things your account can, including posting; Bluesky has no read-only kind. What keeps this
read-only is the program itself: it can only call the four methods listed below, and a test checks that. An app
password cannot change your main password or delete your account, and without the direct-message switch it cannot open
your direct messages. You can take it back at any time under App passwords.

## What it contacts

- Your Bluesky server: `https://bsky.social`, or the `service` you set. Nothing else on the internet.
  - `com.atproto.server.createSession` to log in with the app password, and `com.atproto.server.refreshSession` to
    keep the login going. These two are sent as POST because that is how logging in works; they change nothing on your account.
  - `app.bsky.notification.listNotifications` to read notifications.
  - `app.bsky.feed.getTimeline` to read the home timeline, only if you switched it on.
- Clockwork on this machine, to hand over the items.

## What it stores

In `~/.clockwork/v2/extractor-data/bluesky/`, readable only by you:

- `login.json`: what you saved.
- `state.json`: the login session Bluesky gave it (two tokens) and where it stopped reading. No post text is kept here.

The posts themselves go into Clockwork like any other item.

## Limits

- The first run brings in the last 24 hours, marked as history. After that it looks once every two minutes.
- It reads at most 500 notifications (and 150 timeline posts) in one go. After a long break, older ones are left out.
- A post that is only a picture or a video arrives without text and is marked as such.
- Posts you reply to are not fetched, so a reply arrives without the post it answers unless that is already in Clockwork.
- If you set up sign-in by email code and use your main password by mistake, Bluesky refuses the login. Use an app password.

## Risk to your account

Low. This is Bluesky's own published way for programs to read an account, and the program goes slowly: one call a
second at most, and it waits when Bluesky says to slow down. If the app password is refused it stops trying until you
change `login.json`, so it cannot use up Bluesky's daily limit on logins. Anyone who can read `login.json` or
`state.json` can act as your account until you remove the app password, so keep them private.

To stop: `clockwork disable bluesky`, and remove the app password in Bluesky.
