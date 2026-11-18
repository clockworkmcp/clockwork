# Hacker News

Brings two things from Hacker News into Clockwork:

- **Replies to you**: new comments that answer one of your comments, and new comments on your stories. They are filed
  under "reply to you".
- **Keyword matches**: new stories and comments that contain a word or phrase you chose. They are filed under
  "keyword: <your word>", so they are easy to tell apart from replies.

Your own new comments and stories come in too, as context only: they are never triaged.

It is read-only and needs no login. It reads the public Hacker News search (the one behind hn.algolia.com), which has no
way to post, vote or change anything.

## Set it up

1. Create a text file like this and save it as `~/.clockwork/v2/extractor-data/hackernews/config.json`:

   ```json
   { "username": "your_hn_name", "keywords": ["sqlite", "\"local first\""] }
   ```

   - `username`: your Hacker News name, spelled exactly as on the site (capitals matter). Leave it out to follow
     keywords only.
   - `keywords`: up to 20. Several words must all appear; put a phrase in quotes (written `\"like this\"` inside the
     file) to match it exactly. Leave it out to get replies only.
2. Run `clockwork connect hackernews`.

Edit the file whenever you like; it is read again on the next pass.

## What it needs

No password, no key, no permission. Never put a password in the file. Everything it reads is public: anyone can see
your comments and the replies to them.

## What it contacts

`hn.algolia.com` (the public Hacker News search), and Clockwork on this machine. Nothing else. It does not contact
news.ycombinator.com; it only writes links to it.

## What it stores

`state.json` next to `config.json`, readable only by you: the numbers of your posts from the last 14 days (to recognise
replies to them), the numbers of items already sent, and when it last looked. No text.

## How it behaves

- It looks every 5 minutes, with a pause of a second and a half before every request. A normal pass is about two
  requests plus one per keyword. The search allows 10,000 requests an hour from one address; this uses a few dozen.
- If the search says "slow down" it waits as long as it is told (a minute if it is not told) before asking again.
- The first run brings in the last 24 hours, marked as history. So does a keyword you add later.
- Each pass looks 10 minutes further back than the last one, because the search can be a little behind the site. Nothing
  is sent twice.

## Limits

- Replies are noticed for posts you made in the last 14 days. A reply to something older is missed.
- The search can run some minutes behind the site, so items arrive with that delay.
- A reply that is edited later is not sent again. Deleted or flagged comments may still have come in before they were
  removed.
- If the name in `config.json` does not exist, Clockwork shows "needs_login" and `clockwork logs hackernews` says so.
- Very busy days: if more than a few thousand new comments appear under the stories you posted in between two looks
  (for example after the computer was off for days), the oldest are left out and the log says so.
- Keyword matching is plain text matching: `rust` can also match a longer word that starts with it, such as "rusty".
- An item is cut at 4,000 characters.

## Risk to your account

None. It does not log in, so it cannot act as you, and your account cannot be limited or banned for it. The only
visible trace is ordinary search requests from your internet address.
