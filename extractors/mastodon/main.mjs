// Mastodon extractor: reads the user's notifications (mentions, posts from people they asked to be told about, quotes,
// ended polls and follow requests) from their own server and posts new ones to Clockwork. Optionally also reads the home
// timeline. Read-only by construction: api() below only ever sends GET, to two paths, and the token the user creates
// has reading permission only. It never dismisses or clears a notification.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_MASTODON_PACE_MS', 1000);            // pause before every call to the server
const FIRST_MS = num('CLOCKWORK_MASTODON_FIRST_HOURS', 24) * 3600_000; // history brought in on the first run
const REST_S = num('CLOCKWORK_MASTODON_REST_SECONDS', 120);         // pause between passes
const ONCE = process.argv.includes('--once');
const SOURCE = 'mastodon';
const PATHS = new Set(['/api/v1/notifications', '/api/v1/timelines/home']);
const WANTED = { mention: 'Mastodon mention', status: 'Mastodon post from someone you follow closely', quote: 'Mastodon quote', poll: 'Mastodon poll ended', follow_request: 'Mastodon follow request' };
const SKIPPED = ['favourite', 'reblog', 'follow', 'update'];        // asked for by name so the server leaves them out; anything else unknown is dropped here

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
const readFile = name => { try { return fs.readFileSync(path.join(DATA, name), 'utf8').trim(); } catch { return ''; } };
const local = u => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u);

/** The saved server address and token, or a plain reason why they cannot be used. The token itself is never printed. */
function readSetup() {
  const token = readFile('token'); let instance = readFile('instance').replace(/\/+$/, '');
  if (!token || !instance) return { problem: `the "${token ? 'instance' : 'token'}" file is missing or empty` };
  if (!/^[a-z]+:\/\//i.test(instance)) instance = 'https://' + instance;
  let host; try { host = new URL(instance).host; } catch { return { problem: 'the "instance" file is not a web address such as https://mastodon.example' }; }
  const api = (process.env.CLOCKWORK_MASTODON_API || instance).replace(/\/+$/, '');
  if (!/^https:\/\//.test(api) && !local(api)) return { problem: 'the address in the "instance" file must start with https://' };
  let settings = {}; try { settings = JSON.parse(readFile('settings.json') || '{}'); } catch { console.error('settings.json is not JSON: ignoring it'); }
  return { token, host, api, timeline: settings.timeline === true, stamp: fs.statSync(path.join(DATA, 'token')).mtimeMs };
}

let lastContact = 0, quietUntil = 0, holdUntil = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

/** Seconds until the server's rate limit starts again, from X-RateLimit-Reset (a date, or seconds) or Retry-After. */
function untilReset(r) {
  const ra = Number(r.headers.get('retry-after')), reset = r.headers.get('x-ratelimit-reset') || '', at = /^\d+(\.\d+)?$/.test(reset) ? Number(reset) * 1000 : Date.parse(reset);
  return ra > 0 ? ra : at > Date.now() ? (at - Date.now()) / 1000 : 30;
}
/** One GET to the user's server. Slows down when the server says few calls are left, and waits out a short 429. */
async function api(setup, p, params = {}) {
  if (!PATHS.has(p)) throw new Error(`refusing to call ${p}: not one of the two things this program reads`);
  const q = new URLSearchParams(); for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) if (x !== undefined && x !== '') q.append(k, String(x));
  for (let attempt = 0; ; attempt++) {
    await sleep(Math.max(PACE_MS, holdUntil - Date.now()));
    const r = await fetch(`${setup.api}${p}?${q}`, { method: 'GET', headers: { authorization: 'Bearer ' + setup.token, accept: 'application/json' } });
    const left = r.headers.get('x-ratelimit-remaining'), wait = untilReset(r);
    if (r.status === 429) {
      if (wait > 300 || attempt >= 3) { quietUntil = Date.now() + Math.min(wait, 3600) * 1000; throw Object.assign(new Error(`mastodon ${p}: rate limited`), { limited: true }); }
      await sleep(wait * 1000); await heartbeat(); continue;
    }
    if (left !== null && Number(left) <= 5) holdUntil = Date.now() + Math.min(wait, 300) * 1000;      // nearly out: wait for the next window before the next call
    if (!r.ok) throw Object.assign(new Error(`mastodon ${p}: http ${r.status}`), { status: r.status });
    return r.json();
  }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Mastodon's HTML to plain text: paragraphs and line breaks become new lines, tags go, character codes are decoded. */
export const plain = html => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<[^>]*>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m).trim();
const newer = (a, b) => a.length !== b.length ? a.length > b.length : a > b;       // ids are numbers written as text
const who = (a, host) => a?.acct ? (a.acct.includes('@') ? a.acct : `${a.acct}@${host}`) : undefined;

/** One post as a Clockwork item. A boost is filed as the post that was boosted. */
export function postItem(status, host, { chatName, isGroup, history, lead = '' }) {
  const s = status.reblog || status, media = s.media_attachments?.[0]?.type, body = [s.spoiler_text && `[${s.spoiler_text}]`, plain(s.content)].filter(Boolean).join('\n');
  if (!body && !media) return null;
  return { sourceId: `${host}:status:${s.id}`, threadId: `${host}:status:${s.in_reply_to_id || s.id}`, author: who(s.account, host), authorName: s.account?.display_name || s.account?.username,
    sourceTime: new Date(status.created_at).toISOString(), direction: 'incoming', isGroup,
    kind: body ? 'text' : media === 'image' ? 'image' : media === 'video' || media === 'gifv' ? 'video' : media === 'audio' ? 'audio' : 'document',
    text: body ? lead + body : '', chatName, origin: history ? 'history' : undefined, url: s.url || s.uri };
}
export function noteItem(n, host, history) {
  const chatName = WANTED[n.type]; if (!chatName) return null;
  if (n.type === 'follow_request') return { sourceId: `${host}:notification:${n.id}`, threadId: `${host}:follow-requests`, author: who(n.account, host), authorName: n.account?.display_name || n.account?.username,
    sourceTime: new Date(n.created_at).toISOString(), direction: 'incoming', isGroup: false, kind: 'text', text: `${n.account?.display_name || n.account?.username} (@${who(n.account, host)}) asked to follow you.`,
    chatName, origin: history ? 'history' : undefined, url: n.account?.url };
  if (!n.status) return null;
  if (n.type !== 'poll') return postItem(n.status, host, { chatName, isGroup: false, history });
  const it = postItem(n.status, host, { chatName, isGroup: false, history, lead: 'A poll you voted in or created has ended: ' });
  return it && { ...it, sourceId: `${host}:notification:${n.id}`, sourceTime: new Date(n.created_at).toISOString() };
}

/** What is new in one list. The first time: the newest page and back, down to 24 hours ago. After that: forward from the last id seen. */
async function collect(setup, p, extra, cur = {}, limit, maxPages, now) {
  const first = !cur.started, floor = first ? now - FIRST_MS : cur.started, out = []; let last = cur.last, edge;
  for (let i = 0; i < maxPages; i++) {
    const list = await api(setup, p, { limit, ...extra, ...(cur.last ? { min_id: last } : { max_id: edge }) }); if (!Array.isArray(list) || !list.length) break;
    for (const e of list) if (!last || newer(e.id, last)) last = e.id;
    const fresh = cur.last ? list : list.filter(e => Date.parse(e.created_at) >= floor); out.push(...fresh);
    edge = list.reduce((m, e) => !m || newer(m, e.id) ? e.id : m, ''); if (list.length < limit || fresh.length < list.length) break;
  }
  return { list: out.sort((a, b) => newer(a.id, b.id) ? 1 : -1), first, cur: { started: cur.started || now, last } };
}

async function pass() {
  if (Date.now() < quietUntil) { await send([], 'rate_limited'); return; }
  const setup = readSetup(), state = loadState();
  if (setup.problem) { console.error(setup.problem); await send([], 'needs_login'); return; }
  if (state.rejected === setup.stamp) { await send([], 'needs_login'); return; }                // already refused: wait for a new token file
  try {
    await send([]);
    const now = Date.now(), notes = await collect(setup, '/api/v1/notifications', { 'exclude_types[]': SKIPPED }, state.notifications, 40, 5, now);
    const home = setup.timeline ? await collect(setup, '/api/v1/timelines/home', {}, state.timeline, 40, 3, now) : null;
    const seen = new Set(state.recent || []), items = [...notes.list.map(n => noteItem(n, setup.host, notes.first)),
      ...(home?.list || []).map(s => postItem(s, setup.host, { chatName: 'Mastodon home timeline', isGroup: true, history: home.first }))].filter(e => e && !seen.has(e.sourceId) && seen.add(e.sourceId));
    let fresh = 0; for (let i = 0; i < items.length; i += 200) fresh += (await send(items.slice(i, i + 200))).new || 0;
    state.notifications = notes.cur; if (home) state.timeline = home.cur; state.recent = [...seen].slice(-300); saveState(state);   // only after the core has the items
    if (items.length) console.log(`pass done: sent ${items.length}, ${fresh} new`);
    await send([]);
  } catch (e) {
    const refused = e.status === 401 || e.status === 403;       // 401: the token is wrong or was revoked. 403: it lacks the permission this read needs.
    if (e.status === 403) e.message += ` (the token needs the read:notifications permission${setup.timeline ? ', and read:statuses for the home timeline' : ''})`;
    if (e.status === 401) { state.rejected = setup.stamp; saveState(state); }
    await send([], refused ? 'needs_login' : e.limited ? 'rate_limited' : 'error').catch(() => {}); throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
