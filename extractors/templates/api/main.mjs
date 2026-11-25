// A Clockwork extractor for a service you read through its API with a key the user saves in a file.
// It needs nothing but Node. The contract is in docs/EXTRACTORS.md. Read-only: every request below is a GET, and it
// should stay that way. Ask the service for the narrowest read-only key it offers.
// What to change is marked "Replace". Everything else (pacing, backing off, saying when the key stopped working,
// keeping state only after the core has the items) is worth keeping as it is.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const TOKEN = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';       // a private folder for this extractor's key and state
const FIXTURES = process.env.CLOCKWORK_FIXTURES || '';          // set by `clockwork check`: read the sample answers in this folder, contact nobody
const SOURCE = JSON.parse(fs.readFileSync(new URL('./extractor.json', import.meta.url), 'utf8')).source;
const ONCE = process.argv.includes('--once');

const API = 'https://api.example.invalid/v1';                   // Replace: the service's API. The key is sent to this host and no other.
const PACE_MS = 1000;                                           // pause before every request: go slowly on the service
const REST_S = 120;                                             // pause between looks
const MAX_PAGES = 20;                                           // pages read in one look; the rest waits for the next
const FIRST_HOURS = 24;                                         // how far back the first run reaches

const sleep = ms => new Promise(r => setTimeout(r, ms));
class NeedsLogin extends Error {}
const readKey = () => { try { return fs.readFileSync(path.join(DATA, 'key'), 'utf8').trim(); } catch { return ''; } };

async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`);
  return r.json();
}

/** One page of what the service lists, newest first: `{ items: [...], next: <cursor or null> }`. Replace the address and how the cursor is passed. */
async function page(key, cursor) {
  if (FIXTURES) return JSON.parse(fs.readFileSync(path.join(FIXTURES, `page-${cursor || 1}.json`), 'utf8'));   // keep: this is how the code below is tried offline
  const url = new URL(API + '/notifications'); if (cursor) url.searchParams.set('cursor', cursor);
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    const r = await fetch(url, { method: 'GET', headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (r.status === 401 || r.status === 403) throw new NeedsLogin(`the service refused the key (${r.status})`);
    if ((r.status === 429 || r.status >= 500) && attempt < 4) { const wait = Number(r.headers.get('retry-after')); await sleep((wait > 0 ? Math.min(wait, 600) : 5 * 2 ** attempt) * 1000); continue; }   // wait as long as it asks; never retry in a tight loop
    if (!r.ok) throw new Error(`the service answered ${r.status}`);
    return r.json();
  }
}

/** Replace this: one thing from the service as a Clockwork item, or null for what should not be brought in. */
function toItem(t, history) {
  if (!t?.id || !t.created_at || Number.isNaN(Date.parse(t.created_at))) return null;
  return {
    sourceId: String(t.id),                                     // the service's own id: the same one is never stored twice
    threadId: t.thread ? String(t.thread) : undefined,
    author: t.from?.handle, authorName: t.from?.name,
    sourceTime: new Date(t.created_at).toISOString(),
    direction: t.mine ? 'outgoing' : 'incoming',                // what the user wrote themself is context, never triaged
    kind: t.attachment && !t.text ? String(t.attachment) : 'text',   // 'image', 'document', ... when there is content Clockwork cannot read
    text: String(t.text ?? '').slice(0, 6000),
    url: t.url || undefined,
    origin: history ? 'history' : undefined,                    // what was already there on the first run does not count as arriving late
  };
}

/** What is new since last time. The service lists newest first, so reading stops at the first thing already seen. */
async function fetchNew(state) {
  const key = readKey(); if (!key && !FIXTURES) throw new NeedsLogin('no key saved yet');
  // The first run brings in the last day as history. (With sample input, all of it: fixtures do not age.)
  const first = state.newest === undefined, floor = !first ? state.newest : FIXTURES ? '' : new Date(Date.now() - FIRST_HOURS * 3600e3).toISOString(), things = [];
  for (let n = 0, cursor; n < MAX_PAGES; n++) {
    const p = await page(key, cursor), all = Array.isArray(p?.items) ? p.items : [], fresh = all.filter(t => String(t?.created_at) > floor);
    things.push(...fresh);
    if (!p?.next || fresh.length < all.length) break;
    cursor = p.next;
  }
  const items = things.map(t => toItem(t, first)).filter(Boolean).sort((a, b) => a.sourceTime < b.sourceTime ? -1 : 1);
  return { items, state: { newest: items.at(-1)?.sourceTime ?? state.newest ?? new Date().toISOString() } };
}

const stateFile = path.join(DATA, 'state.json');
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const save = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
for (;;) {
  try {
    const { items, state } = await fetchNew(load());
    const res = await send(items);                              // an empty list is a heartbeat: "running, nothing new"
    save(state);                                                // only after the core has the items, so a failed delivery is read again
    if (items.length) console.log(`sent ${items.length}, ${res.new} new`);
  } catch (e) {
    console.error('failed:', e.message);                        // never print the key
    await send([], e instanceof NeedsLogin ? 'needs_login' : 'error').catch(() => {});   // say so, and try again next time: never stop without a word
  }
  if (ONCE) break;
  await sleep(REST_S * 1000);
}
