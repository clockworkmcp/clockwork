// Turn any X GraphQL timeline response into normalized events.
// Finds tweets by walking the JSON for `tweet_results`, so it does not depend on the exact timeline path.
function unwrap(r) { return r && r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r; }
function user(t) {
  const u = t?.core?.user_results?.result; if (!u) return {};
  return { handle: u.core?.screen_name ?? u.legacy?.screen_name, name: u.core?.name ?? u.legacy?.name, id: u.rest_id };
}
function text(t) { return t?.note_tweet?.note_tweet_results?.result?.text ?? t?.legacy?.full_text ?? ''; }
function one(raw, ctx) {
  const t = unwrap(raw); if (!t || !t.rest_id || !t.legacy) return null;
  const L = t.legacy, u = user(t), rt = unwrap(L.retweeted_status_result?.result), q = unwrap(t.quoted_status_result?.result);
  const body = rt ? text(rt) : text(t);
  return {
    sourceId: t.rest_id, threadId: L.conversation_id_str ?? t.rest_id,
    author: u.handle ? '@' + u.handle : undefined, authorName: u.name,
    sourceTime: L.created_at ? new Date(L.created_at).toISOString() : undefined,
    text: body, url: u.handle ? `https://x.com/${u.handle}/status/${t.rest_id}` : undefined,
    completeness: 'complete',
    metadata: {
      retweetOf: rt ? '@' + (user(rt).handle ?? '') : undefined,
      quoted: q ? { author: '@' + (user(q).handle ?? ''), text: text(q) } : undefined,
      replyTo: L.in_reply_to_screen_name ? '@' + L.in_reply_to_screen_name : undefined,
      media: (L.extended_entities?.media ?? L.entities?.media ?? []).map(m => ({ type: m.type, url: m.media_url_https, alt: m.ext_alt_text })),
      links: (L.entities?.urls ?? []).map(x => x.expanded_url),
      lang: L.lang, likes: L.favorite_count, reposts: L.retweet_count, replies: L.reply_count, views: Number(t.views?.count) || undefined,
      promoted: ctx.promoted || undefined, socialContext: ctx.social, noteTweet: !!t.note_tweet,
    },
  };
}
export function parseTimeline(json) {
  const out = new Map(); let entries = 0, cursors = 0;
  (function walk(n, ctx) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x, ctx); return; }
    if (typeof n.entryId === 'string') { entries++; if (n.entryId.startsWith('cursor-')) cursors++; }
    if (n.tweet_results?.result) {
      const c = { promoted: !!n.promotedMetadata || ctx.promoted, social: n.socialContext?.text ?? ctx.social };
      const ev = one(n.tweet_results.result, c); if (ev && !out.has(ev.sourceId)) out.set(ev.sourceId, ev);
      return; // quoted/retweeted tweets are folded into the parent
    }
    for (const k in n) walk(n[k], ctx);
  })(json, {});
  return { events: [...out.values()], entries, cursors };
}
