// A Clockwork extractor that reads another app's own store on this Mac: the SQLite file the app keeps its messages in.
// It needs nothing but Node 24. The contract is in docs/EXTRACTORS.md. Read-only: the store is opened for reading, and
// nothing in this file writes to it or sends anything on the user's behalf.
// What to change is marked "Replace". Before you write a query, learn the store's shape from the real file, read-only:
//   sqlite3 'file:/path/to/store.sqlite?mode=ro' .schema
// Three things about stores other apps own:
//   - Opened read-only next to its `-wal` and `-shm` files, a store shows what the app has written so far. If the app
//     keeps it locked ("database is locked"), copy all three files into CLOCKWORK_EXTRACTOR_DATA and open the copy.
//   - macOS lets a program read another app's files only once the user has given Full Disk Access to whatever runs
//     Clockwork. Until then opening fails, and this program says `needs_login` instead of stopping.
//   - An app update can rename a table or a column. `NEEDS` below is checked on every look, so that shows up as a clear
//     message naming what went missing, not as wrong or empty items.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { DatabaseSync } from 'node:sqlite';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const TOKEN = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';       // a private folder for this extractor's own state
const FIXTURES = process.env.CLOCKWORK_FIXTURES || '';          // set by `clockwork check`: build the sample store in this folder, touch no real one
const SOURCE = JSON.parse(fs.readFileSync(new URL('./extractor.json', import.meta.url), 'utf8')).source;
const ONCE = process.argv.includes('--once');

const STORE = path.join(os.homedir(), 'Library', 'Application Support', 'Example App', 'store.sqlite');   // Replace: where the app keeps its store
const NEEDS = { chats: ['id', 'title', 'is_group'], messages: ['id', 'chat_id', 'sender', 'sender_name', 'sent_at', 'from_me', 'body', 'media'] };   // Replace: every table and column the query reads
const QUERY = `SELECT m.id, m.chat_id, m.sender, m.sender_name, m.sent_at, m.from_me, m.body, m.media, c.title, c.is_group
  FROM messages m LEFT JOIN chats c ON c.id = m.chat_id WHERE m.id > ? ORDER BY m.id LIMIT 200`;           // Replace. Keep "newer than the last one read, oldest first, a page at a time".
const FIRST = 50;                                               // how many of the newest rows to bring in as history on the first run
const REST_S = 60;                                              // pause between looks

class NoAccess extends Error {}

async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`);
  return r.json();
}

/** Open the store for reading only. */
function open() {
  if (FIXTURES) { const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(path.join(FIXTURES, 'store.sql'), 'utf8')); return db; }   // keep: this is how the code below is tried offline
  try { const db = new DatabaseSync(STORE, { readOnly: true }); db.prepare('SELECT count(*) FROM sqlite_master').get(); return db; }
  catch (e) { if (/unable to open|authorization denied|not permitted|permission denied|not authorized/i.test(e.message)) throw new NoAccess(e.message); throw e; }
}
/** The tables and columns this program reads that the store does not have (any more). */
function missing(db) {
  const out = [];
  for (const [table, columns] of Object.entries(NEEDS)) { const has = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name)); if (!has.size) out.push(`table ${table}`); else for (const c of columns) if (!has.has(c)) out.push(`${table}.${c}`); }
  return out;
}

/** Replace this: one row of the store as a Clockwork item, or null for what should not be brought in. */
function toItem(row, history) {
  if (row.id == null || !Number.isFinite(Number(row.sent_at))) return null;
  const mine = !!row.from_me;
  return {
    sourceId: String(row.id),                                   // better still: an id the app gives the message itself, the same on every device
    threadId: String(row.chat_id),
    author: mine ? undefined : row.sender ?? undefined, authorName: mine ? undefined : row.sender_name ?? undefined,
    sourceTime: new Date(Number(row.sent_at) * 1000).toISOString(),   // Replace: stores keep time in many ways (seconds, milliseconds, Apple's 2001 epoch)
    direction: mine ? 'outgoing' : 'incoming',                  // what the user wrote themself is context, never triaged
    isGroup: !!row.is_group, chatName: row.title ?? undefined,
    kind: row.media && !row.body ? String(row.media) : 'text',  // 'image', 'audio', ... when there is content Clockwork cannot read
    text: String(row.body ?? '').slice(0, 6000),
    origin: history ? 'history' : undefined,                    // what was already there on the first run does not count as arriving late
  };
}

/** Rows newer than the last one read, and where to continue from. */
function readNew(state) {
  const db = open();
  try {
    const gone = missing(db); if (gone.length) throw new Error(`the app's store is not shaped as this program expects (missing: ${gone.join(', ')}). The app was probably updated; this extractor needs updating too`);
    const first = state.last === undefined, from = first ? Math.max(0, db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages').get().n - FIRST) : state.last;
    const rows = db.prepare(QUERY).all(from);
    return { items: rows.map(r => toItem(r, first)).filter(Boolean), state: { last: rows.length ? rows.at(-1).id : from } };
  } finally { db.close(); }
}

const stateFile = path.join(DATA, 'state.json');
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
for (;;) {
  try {
    const { items, state } = readNew(load());
    const res = await send(items);                              // an empty list is a heartbeat: "running, nothing new"
    fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state));   // only after the core has the items
    if (items.length) console.log(`sent ${items.length}, ${res.new} new`);
  } catch (e) {
    console.error('failed:', e.message);
    await send([], e instanceof NoAccess ? 'needs_login' : 'error').catch(() => {});   // say so, and try again next time: never stop without a word
  }
  if (ONCE) break;
  await new Promise(r => setTimeout(r, REST_S * 1000));
}
