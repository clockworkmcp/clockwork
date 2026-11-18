// Hacker News extractor: brings in replies to the user's comments and stories, and new stories and comments that match
// the user's keywords, through the public Hacker News search API (hn.algolia.com). No login, no account, no key.
// Read-only by construction: the search API cannot post or vote, and this program only ever sends GET requests to it.
// To find replies it remembers the user's own posts from the last two weeks, asks for the new comments under the same
// stories, and keeps the ones whose parent is one of the user's posts.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const API = (process.env.CLOCKWORK_HACKERNEWS_API || 'https://hn.algolia.com/api/v1').replace(/\/$/, '');
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_HACKERNEWS_PACE_MS', 1500);            // pause before every call to the search API
const REST_S = num('CLOCKWORK_HACKERNEWS_REST_SECONDS', 300);         // pause between passes
const FIRST_S = num('CLOCKWORK_HACKERNEWS_FIRST_HOURS', 24) * 3600;   // history brought in on the first run, and for a new keyword
const TRACK_S = num('CLOCKWORK_HACKERNEWS_TRACK_DAYS', 14) * 86400;   // how long one of the user's posts is watched for replies
const OVERLAP_S = num('CLOCKWORK_HACKERNEWS_OVERLAP_SECONDS', 600);   // each pass looks this far back again: the search index can lag
const AGENT = process.env.CLOCKWORK_HACKERNEWS_USER_AGENT || 'clockwork-hackernews/1.0 (personal reader; read-only)';
const MAX_TEXT = 4000, MAX_KEYWORDS = 20, STORIES_PER_CALL = 20;
const ONCE = process.argv.includes('--once');
const SOURCE = 'hackernews', SITE = 'https://news.ycombinator.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json'), configFile = path.join(DATA, 'config.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };

/** config.json: { "username": "...", "keywords": ["..."] }. Either may be left out, not both. Null when there is nothing usable. */
export function readConfig(text) {
  let j; try { j = JSON.parse(text); } catch { return null; } if (!j || typeof j !== 'object') return null;
  const username = typeof j.username === 'string' ? j.username.trim() : '';
  const keywords = [...new Set((Array.isArray(j.keywords) ? j.keywords : []).filter(k => typeof k === 'string').map(k => k.trim().replace(/\s+/g, ' ').slice(0, 100)).filter(Boolean))].slice(0, MAX_KEYWORDS);
  if (username && !/^[A-Za-z0-9_-]{1,40}$/.test(username)) return null;
  return username || keywords.length ? { username, keywords } : null;
}

let lastContact = 0;
async function send(events, status = 'ok') {
  const core = e => Object.assign(e, { core: true });                 // a failure of the core is not a failure of Hacker News
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) }).catch(() => { throw core(new Error('could not reach the core')); });
  if (!r.ok) throw core(new Error(`core answered ${r.status}`)); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };
const sendAll = async items => { let fresh = 0; for (let i = 0; i < items.length; i += 200) fresh += (await send(items.slice(i, i + 200))).new || 0; return fresh; };

/** One GET to the search API. Waits out a rate limit as long as it is told to (a minute when it is not told), a few times at most. */
async function hn(pathname, params) {
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    const r = await fetch(`${API}${pathname}${params ? '?' + new URLSearchParams(params) : ''}`, { method: 'GET', headers: { 'user-agent': AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
      .catch(e => { throw new Error(`hacker news search: could not reach it (${e.cause?.code || e.name})`); });
    if (r.status === 429 && attempt < 4) { const ra = Number(r.headers.get('retry-after')); await r.body?.cancel(); await sleep(Math.min(900, Math.max(1, ra || 60)) * 1000); await heartbeat(); continue; }
    if (!r.ok) { await r.body?.cancel(); throw Object.assign(new Error(`hacker news search ${pathname.split('/')[1]}: http ${r.status}`), { http: r.status }); }
    return r.json();
  }
}
/** Everything newer than `since` that matches, newest first. One question gives at most 1000 results, in pages; when there
 *  are more, it asks again for what is older than the oldest result so far, up to `maxCalls` calls in all. */
async function search(params, since, maxCalls = 40) {
  const out = new Map(); let before = Infinity, page = 0;
  for (let calls = 0; ; calls++) {
    if (calls >= maxCalls) { console.error('more new posts than can be read in one go: the oldest were left out'); break; }
    const j = await hn('/search_by_date', { ...params, numericFilters: `created_at_i>${since}${before < Infinity ? `,created_at_i<${before}` : ''}`, hitsPerPage: 100, page });
    for (const h of j.hits || []) if (h?.objectID && Number.isFinite(h.created_at_i)) out.set(String(h.objectID), h);
    if (page + 1 < (j.nbPages || 0)) { page++; continue; }
    const oldest = Math.min(...[...out.values()].map(h => h.created_at_i)) + 1;                 // + 1: posts of the same second are asked for again, not lost
    if (!((j.nbHits || 0) > (j.nbPages || 0) * (j.hitsPerPage || 100)) || !(oldest < before)) break;
    before = oldest; page = 0;
  }
  return [...out.values()];
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
  const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
});
/** Hacker News markup (paragraphs, links, italics, code) to plain text. */
export const toText = html => decode(String(html || '').replace(/<p\b[^>]*>/gi, '\n\n').replace(/<br\b[^>]*>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '')).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const isComment = h => (h._tags || []).includes('comment') || typeof h.comment_text === 'string';
const storyOf = h => String(h.story_id ?? h.objectID);

export function toItem(h, { me, chatName, history }) {
  const id = String(h.objectID), title = toText(h.story_title || h.title || ''), body = toText(isComment(h) ? h.comment_text : h.story_text);
  const text = isComment(h) ? (title ? `On "${title}":\n` : '') + body : [title, h.url, body].filter(Boolean).join('\n');
  return { sourceId: id, threadId: storyOf(h), author: h.author, authorName: h.author, sourceTime: new Date(h.created_at_i * 1000).toISOString(),
    direction: me && h.author === me ? 'outgoing' : 'incoming', isGroup: true, kind: 'text', text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1).trimEnd() + '…' : text,
    chatName, origin: history ? 'history' : undefined, url: `${SITE}/item?id=${id}` };
}
/** The search is forgiving about spelling; a keyword match is kept only when every word (or "quoted phrase") really is in the text. */
export function matches(keyword, h) {
  const hay = (isComment(h) ? toText(h.comment_text) : [h.title, h.url, toText(h.story_text)].filter(Boolean).join(' ')).toLowerCase();
  const parts = [...keyword.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)].map(m => (m[1] ?? m[2]).replace(/"/g, '').trim()).filter(Boolean);
  return parts.length > 0 && parts.every(p => hay.includes(p));
}

/** The user's own new posts (kept as context) and the new replies to anything they posted in the last two weeks. */
async function readReplies(state, me, now) {
  const first = !state.since, since = first ? now - FIRST_S : state.since - OVERLAP_S, items = [];
  const own = await search({ tags: `author_${me}` }, first ? now - TRACK_S : since);
  if (!own.length && !state.known) {                                  // nothing posted lately: make sure the name exists before watching it for ever
    try { await hn(`/users/${encodeURIComponent(me)}`); } catch (e) { if (e.http) throw Object.assign(new Error(`no Hacker News user "${me}" was found: check the spelling (capitals matter) in config.json`), { login: true }); throw e; }
  }
  state.known = true; state.mine ||= {};
  for (const h of own) state.mine[h.objectID] = [Number(storyOf(h)), h.created_at_i];
  for (const id of Object.keys(state.mine)) if (state.mine[id][1] < now - TRACK_S) delete state.mine[id];
  const take = (h, chatName) => { if (state.sent[h.objectID] || h.created_at_i <= since) return; state.sent[h.objectID] = h.created_at_i; items.push(toItem(h, { me, chatName, history: first })); };
  for (const h of own) take(h, undefined);
  const stories = [...new Set(Object.values(state.mine).map(m => m[0]))];
  for (let i = 0; i < stories.length; i += STORIES_PER_CALL) {
    const hits = await search({ tags: `comment,(${stories.slice(i, i + STORIES_PER_CALL).map(s => 'story_' + s).join(',')})` }, since, 60);
    for (const h of hits) if (h.author !== me && state.mine[h.parent_id]) take(h, 'reply to you');
  }
  state.since = now;
  return items.sort((a, b) => a.sourceTime < b.sourceTime ? -1 : 1);
}
async function readKeyword(state, keyword, me, now) {
  const first = !state.kw[keyword], since = first ? now - FIRST_S : state.kw[keyword] - OVERLAP_S, items = [];
  for (const h of await search({ query: keyword, tags: '(story,comment)' }, since, 10)) {
    if (state.sent[h.objectID] || h.author === me || !matches(keyword, h)) continue;
    state.sent[h.objectID] = h.created_at_i; items.push(toItem(h, { me, chatName: `keyword: ${keyword}`, history: first }));
  }
  state.kw[keyword] = now;
  return items.sort((a, b) => a.sourceTime < b.sourceTime ? -1 : 1);
}

async function pass() {
  let cfg = null; try { cfg = readConfig(fs.readFileSync(configFile, 'utf8')); } catch {}
  if (!cfg) { await send([], 'needs_login'); return; }                // no config.json yet, or nothing usable in it
  let state = loadState(); if (state.user !== cfg.username) state = { user: cfg.username, kw: state.kw, sent: state.sent };      // another name: start its replies afresh
  state.kw ||= {}; state.sent ||= {};
  for (const k of Object.keys(state.kw)) if (!cfg.keywords.includes(k)) delete state.kw[k];
  await send([]);
  const now = Math.floor(Date.now() / 1000), jobs = [...(cfg.username ? [s => readReplies(s, cfg.username, now)] : []), ...cfg.keywords.map(k => s => readKeyword(s, k, cfg.username, now))];
  let sent = 0, fresh = 0, failed = 0;
  for (const job of jobs) {
    try {
      const next = structuredClone(state), items = await job(next);    // each step works on a copy, kept only once the core has its items
      for (const id of Object.keys(next.sent)) if (next.sent[id] < now - Math.max(FIRST_S, OVERLAP_S) - 3600) delete next.sent[id];
      fresh += await sendAll(items); sent += items.length; state = next; saveState(state);
    } catch (e) {
      if (e.core) throw e;
      if (e.login) { console.error(e.message); await send([], 'needs_login'); return; }
      failed++; console.error(e.message);
    }
    await heartbeat();
  }
  if (sent || failed) console.log(`pass done: sent ${sent}, ${fresh} new${failed ? `, ${failed} step(s) failed` : ''}`);
  await send([], failed === jobs.length ? 'error' : 'ok');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
