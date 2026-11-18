# RSS and other feeds

Brings new entries from the feeds you list into Clockwork. It understands RSS, Atom and JSON Feed, so it covers most
things that publish a feed:

- blogs and news sites
- podcasts (the episode notes; the audio itself is not downloaded)
- status pages of services you depend on
- YouTube channels (each channel has a feed: `https://www.youtube.com/feeds/videos.xml?channel_id=<the channel's id>`)
- Reddit private inbox feeds (Reddit: Preferences, "RSS feeds") and other feeds that are private to you

It is read-only. The only thing it does to a feed is fetch it.

## Set it up

1. Create a plain text file with one feed address per line and save it as
   `~/.clockwork/v2/extractor-data/rss/feeds.txt`. Keep it to yourself: `chmod 600` it.

   ```
   # Lines starting with # are notes. Blank lines are fine.
   https://blog.example.com/feed.xml
   Status page = https://status.example.com/history.atom
   ```

   `name = address` shows the feed under your own name instead of the feed's title.
2. Run `clockwork connect rss`.

To add or remove a feed later, edit the file. It is read again every minute; no restart is needed.

## What it needs

No account, no password, no permission. If a feed address contains a private key (a Reddit inbox feed does), **that
address is the key**: anyone who has it can read that feed. The extractor never prints a feed address and does not copy it
anywhere; it lives only in your `feeds.txt`.

## What it contacts

Only the addresses in your `feeds.txt` (and wherever those redirect to), and Clockwork on this machine. Nothing else.

## What it stores

`state.json` next to `feeds.txt`, readable only by you: for each feed, which entries were already sent, when to look
next, and the "only if changed" markers the feed gave. No feed addresses and no entry text.

## How it behaves

- Each feed is fetched at most every 15 minutes, one feed at a time with a pause in between, and it asks for the feed
  "only if changed" where the feed supports that.
- If a feed says "slow down" it waits as long as the feed asks (an hour if it does not say). A feed that fails is tried
  again later, waiting longer each time, up to six hours. One broken feed does not stop the others; `clockwork logs rss`
  names it by its label or site.
- The first time a feed is read, only entries dated within the last 24 hours come in, marked as history. After that,
  every entry comes in once.

## Limits

- Text only: markup is removed, and an entry is cut at 4,000 characters. Pictures, audio and video are not fetched.
- An entry that is edited after it was published is not sent again.
- At most 100 new entries per feed per visit (the newest), and a feed larger than 5 MB is skipped.
- Entries with no date are skipped on the first visit, because their age cannot be known.
- All entries of one feed are filed as one conversation, named after the feed.
- Changing a feed's address counts as a new feed.

## Risk to your accounts

None for public feeds: fetching a feed is what feed readers do. For private feeds the risk is the address itself (see
above): do not share `feeds.txt`, and if it leaks, reset the feed's key at the service that issued it.
