// Bluesky extractor: reads the user's notifications (replies, mentions and quotes) through the AT Protocol's HTTP API and
// posts new ones to Clockwork. Optionally also reads the home timeline. Read-only by construction: every call goes
// through xrpc() below, which refuses anything but the reading methods in READS and the two login methods in LOGIN.
// Logging in is a POST, but it changes nothing on the account. It never calls updateSeen, so nothing is marked as read.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_BLUESKY_PACE_MS', 1000);            // pause before every Bluesky call
const FIRST_MS = num('CLOCKWORK_BLUESKY_FIRST_HOURS', 24) * 3600_000; // history brought in on the first run
const REST_S = num('CLOCKWORK_BLUESKY_REST_SECONDS', 120);         // pause between passes
const ONCE = process.argv.includes('--once');
const SOURCE = 'bluesky';
const READS = new Set(['app.bsky.notification.listNotifications', 'app.bsky.feed.getTimeline']);
const LOGIN = new Set(['com.atproto.server.createSession', 'com.atproto.server.refreshSession']);
const WANTED = { reply: 'Bluesky reply', mention: 'Bluesky mention', quote: 'Bluesky quote' };   // likes, reposts, follows and the rest are skipped
const AUTH = new Set(['ExpiredToken', 'InvalidToken', 'AuthMissing', 'AuthenticationRequired']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json'), loginFile = path.join(DATA, 'login.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
const local = u => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u);

/** The saved login, or a plain reason why it cannot be used. The password itself is never printed. */
function readLogin() {
  let j, stamp; try { j = JSON.parse(fs.readFileSync(loginFile, 'utf8')); stamp = fs.statSync(loginFile).mtimeMs; } catch { return { problem: 'login.json is missing or is not JSON' }; }
  const handle = String(j.handle || '').trim().replace(/^@/, ''), appPassword = String(j.appPassword || '').trim();
  const service = (process.env.CLOCKWORK_BLUESKY_API || j.service || 'https://bsky.social').replace(/\/+$/, '');
  if (!handle || !appPassword) return { problem: 'login.json needs "handle" and "appPassword"' };
  if (!/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/i.test(appPassword)) return { problem: '"appPassword" does not look like an app password (xxxx-xxxx-xxxx-xxxx). Never put your main password here: create an app password in Bluesky under Settings, Privacy and security, App passwords' };
  if (!/^https:\/\//.test(service) && !local(service)) return { problem: '"service" must start with https://' };
  return { handle, appPassword, service, timeline: j.timeline === true, stamp };
}

let lastContact = 0, quietUntil = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

/** One call to the Bluesky service. Waits out short rate limits and gives up on long ones until they have passed. */
async function xrpc(service, nsid, { token, params = {}, body } = {}) {
  const post = LOGIN.has(nsid); if (!post && !READS.has(nsid)) throw new Error(`refusing to call ${nsid}: not a reading method`);
  const q = new URLSearchParams(); for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) if (x !== undefined && x !== '') q.append(k, String(x));
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    const r = await fetch(`${service}/xrpc/${nsid}${post || !q.size ? '' : '?' + q}`, { method: post ? 'POST' : 'GET',
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) {
      const ra = Number(r.headers.get('retry-after')), reset = Number(r.headers.get('ratelimit-reset')), wait = ra > 0 ? ra : reset > 0 ? Math.max(1, reset - Date.now() / 1000) : 30;
      if (wait > 300 || attempt >= 3) { quietUntil = Date.now() + Math.min(wait, 3600) * 1000; throw Object.assign(new Error(`bluesky ${nsid}: rate limited`), { limited: true }); }
      await sleep(wait * 1000); await heartbeat(); continue;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`bluesky ${nsid}: ${typeof j.error === 'string' ? j.error : 'http ' + r.status}`), { status: r.status, code: j.error });
    return j;
  }
}
const authError = e => e.status === 401 || AUTH.has(e.code);

/** Log in with the app password. A rejected login is remembered so it is not tried again until login.json changes. */
async function logIn(state, login) {
  let j; try { j = await xrpc(login.service, 'com.atproto.server.createSession', { body: { identifier: login.handle, password: login.appPassword } }); }
  catch (e) { if (e.status === 400 || e.status === 401) { state.rejected = login.stamp; delete state.session; saveState(state); e.needsLogin = true; } throw e; }
  state.session = { accessJwt: j.accessJwt, refreshJwt: j.refreshJwt, did: j.did, handle: j.handle, for: `${login.handle} ${login.service}` }; delete state.rejected; saveState(state);
}
/** A new access token from the refresh token; if that is no longer accepted, a fresh login. */
async function renew(state, login) {
  try { const j = await xrpc(login.service, 'com.atproto.server.refreshSession', { token: state.session.refreshJwt });
    Object.assign(state.session, { accessJwt: j.accessJwt, refreshJwt: j.refreshJwt, did: j.did, handle: j.handle }); saveState(state); }
  catch (e) { if (!authError(e) && e.status !== 400) throw e; await logIn(state, login); }
}
async function read(state, login, nsid, params) {
  try { return await xrpc(login.service, nsid, { token: state.session.accessJwt, params }); }
  catch (e) { if (!authError(e)) throw e; await renew(state, login); return xrpc(login.service, nsid, { token: state.session.accessJwt, params }); }
}

const rkey = uri => String(uri).split('/').pop();
/** One post as a Clockwork item. `at` is when Bluesky indexed it, used when the post's own date is missing or in the future. */
export function toItem({ uri, author, record, at, chatName, isGroup, history, me }) {
  if (!uri || record?.$type !== 'app.bsky.feed.post') return null;
  const text = String(record.text || ''), embed = String(record.embed?.media?.$type || record.embed?.$type || ''); if (!text && !embed) return null;
  const made = Date.parse(record.createdAt), when = made <= at ? made : at;
  return { sourceId: uri, threadId: record.reply?.root?.uri || uri, author: author?.did, authorName: author?.displayName || author?.handle,
    sourceTime: new Date(when).toISOString(), direction: author?.did === me ? 'outgoing' : 'incoming', isGroup,
    kind: text ? 'text' : /images|gallery/.test(embed) ? 'image' : /video/.test(embed) ? 'video' : 'document', text, chatName, origin: history ? 'history' : undefined,
    url: `https://bsky.app/profile/${author?.did}/post/${rkey(uri)}` };
}

/** Walks a newest-first list back to where the last pass stopped (or 24 hours on the first run). Returns the items and the position to remember. */
async function collect(cur = {}, now, maxPages, page, map) {
  const first = cur.last === undefined, floor = first ? now - FIRST_MS : cur.last, recent = new Set(cur.recent || []), items = []; let cursor, newest = cur.last ?? now - 300_000;
  for (let i = 0, done = false; i < maxPages && !done; i++) {
    const { list, next } = await page(cursor); cursor = next; done = !next || !list.length;
    for (const entry of list) {
      const { at, item } = map(entry, first); if (!(at >= floor)) { done = true; continue; }
      if (at > newest) newest = at;
      if (item && !recent.has(item.sourceId)) { recent.add(item.sourceId); items.push(item); }
    }
  }
  return { items: items.reverse(), cur: { last: newest, recent: [...recent].slice(-300) } };
}

async function pass() {
  if (Date.now() < quietUntil) { await send([], 'rate_limited'); return; }
  const login = readLogin(), state = loadState();
  if (login.problem) { console.error(login.problem); await send([], 'needs_login'); return; }
  if (state.rejected === login.stamp) { await send([], 'needs_login'); return; }                // already refused: wait for a new login.json
  if (state.session?.for !== `${login.handle} ${login.service}`) delete state.session;
  try {
    if (!state.session) await logIn(state, login);
    await send([]);
    const me = state.session.did, now = Date.now(), get = (nsid, params) => read(state, login, nsid, params);
    const notes = await collect(state.notifications, now, 10,
      async cursor => { const j = await get('app.bsky.notification.listNotifications', { limit: 50, cursor, reasons: Object.keys(WANTED) }); return { list: j.notifications || [], next: j.cursor }; },
      (n, history) => ({ at: Date.parse(n.indexedAt), item: WANTED[n.reason] ? toItem({ uri: n.uri, author: n.author, record: n.record, at: Date.parse(n.indexedAt), chatName: WANTED[n.reason], isGroup: false, history, me }) : null }));
    const home = login.timeline ? await collect(state.timeline, now, 3,
      async cursor => { const j = await get('app.bsky.feed.getTimeline', { limit: 50, cursor }); return { list: j.feed || [], next: j.cursor }; },
      (f, history) => { const at = Date.parse(f.reason?.indexedAt || f.post?.indexedAt);
        return { at, item: toItem({ uri: f.post?.uri, author: f.post?.author, record: f.post?.record, at, chatName: 'Bluesky home timeline', isGroup: true, history, me }) }; }) : null;
    const known = new Set(notes.cur.recent), items = [...notes.items, ...(home?.items || []).filter(e => !known.has(e.sourceId))]; let fresh = 0;   // a reply can be in both lists
    for (let i = 0; i < items.length; i += 200) fresh += (await send(items.slice(i, i + 200))).new || 0;
    state.notifications = notes.cur; if (home) state.timeline = home.cur; saveState(state);    // only after the core has the items
    if (items.length) console.log(`pass done: sent ${items.length}, ${fresh} new`);
    await send([]);
  } catch (e) { await send([], e.needsLogin ? 'needs_login' : e.limited ? 'rate_limited' : 'error').catch(() => {}); throw e; }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
