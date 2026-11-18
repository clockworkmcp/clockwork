# Mastodon

Brings your Mastodon notifications into Clockwork:

- **mentions** (including private mentions) and **quotes** of your posts,
- **posts from people you asked to be told about** (the bell on their profile),
- **polls that ended** which you voted in or created,
- **follow requests**.

Favourites, boosts, new followers, edits of posts you boosted, and notices for moderators and admins are skipped,
because they rarely need an answer.

It only reads. It never posts, replies, favourites, boosts or follows, it never accepts or rejects a follow request,
and it never dismisses or clears a notification: your notifications in Mastodon stay exactly as they were.

## Set it up

1. Save the address of your server in `~/.clockwork/v2/extractor-data/mastodon/instance`, for example
   `https://mastodon.example`.
2. On your server's website, open **Preferences**, then **Development**, then **New application**. Name it
   "clockwork". Under the permissions, **untick everything except `read:notifications`**. Save.
3. Open the application you just made and copy **"Your access token"** into
   `~/.clockwork/v2/extractor-data/mastodon/token`. Keep the file to yourself: `chmod 600` it.
4. Run `clockwork connect mastodon`.

To also bring in your home timeline (posts from the people you follow), tick `read:statuses` as well in step 2, and
save a file `settings.json` next to the token containing `{ "timeline": true }`. It is off by default: a timeline is a
lot of items that are not addressed to you.

## Permission

`read:notifications` only. A token with just that permission cannot post, follow, or change or dismiss anything, even
if this program tried to. With the home timeline on it also needs `read:statuses`, which lets it read posts you can see.

## What it contacts

- Your Mastodon server, the one in the `instance` file. Nothing else on the internet.
  - `GET /api/v1/notifications` to read notifications.
  - `GET /api/v1/timelines/home` to read the home timeline, only if you switched it on.
- Clockwork on this machine, to hand over the items.

## What it stores

In `~/.clockwork/v2/extractor-data/mastodon/`, readable only by you:

- `instance`, `token` and `settings.json`: what you saved.
- `state.json`: where it stopped reading. No post text and no token is kept here.

The posts themselves go into Clockwork like any other item.

## Limits

- The first run brings in the last 24 hours, marked as history. After that it looks once every two minutes.
- It reads at most 200 notifications (and 120 timeline posts) in one go; the rest follow on the next look.
- A post that is only a picture, video or sound arrives without text and is marked as such.
- Posts in one conversation are only linked to the post they directly answer, and the post you were answering is not
  fetched. Following a whole conversation would need a wider permission.
- With the home timeline on, your own posts arrive as if someone else wrote them: the narrow permission does not let
  the program ask who you are.
- If a notification's post was deleted, it is skipped.

## Risk to your account

Very low. This is Mastodon's own way for programs to read an account, with a token that can only read. The program
goes slowly: one call a second at most, it slows down further when the server says few calls are left, and it waits
when the server says stop. If the token is refused it stops trying until you change the `token` file. Anyone who can
read the `token` file can read your notifications until you delete the application, so keep it private. Some servers
have their own rules about automated reading: check yours if unsure.

To stop: `clockwork disable mastodon`, and delete the application under Preferences, Development.
