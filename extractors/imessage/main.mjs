// iMessage extractor: reads new iMessage and SMS texts from the Messages database on this Mac and posts them to Clockwork.
// Read-only by construction: the database is opened with SQLite's read-only mode and only SELECT statements are run.
// It does nothing until the file `enabled` exists in its data folder (`clockwork connect imessage` creates it), so a
// trial run (`clockwork check`) or an install where the user has not said yes never opens the database.
// Senders are shown as the phone number or address Messages has for them; Contacts is never read.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const OVERRIDE = process.env.CLOCKWORK_IMESSAGE_DB || '';        // another database file, for tests
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const POLL_S = num('CLOCKWORK_IMESSAGE_POLL_SECONDS', 30);       // how often the database is looked at
const FIRST_MS = num('CLOCKWORK_IMESSAGE_FIRST_HOURS', 24) * 3600_000;   // history brought in on the first run
const ONCE = process.argv.includes('--once');
const SOURCE = 'imessage';
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);                     // Messages counts time from 2001-01-01 UTC
// Milliseconds since 2001, whichever unit the row uses: nanoseconds on modern macOS, seconds on old ones. Done in SQL
// because nanosecond values do not fit a JavaScript number.
const MS = 'CASE WHEN m.date > 100000000000 THEN m.date / 1000000 ELSE m.date * 1000 END';
const ACCESS_HELP = 'macOS did not let this program read your Messages. Give Full Disk Access to the program that runs Clockwork (your terminal app, or node): '
  + 'System Settings > Privacy & Security > Full Disk Access, then start Clockwork again. Only you can do that; Clockwork cannot and will not do it for you.';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json'), flagFile = path.join(DATA, 'enabled');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };

let lastContact = 0, lastStatus = '';
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); lastStatus = status; return r.json();
}
/** Report in when the state changed or it has been five minutes: "running, nothing new". */
const heartbeat = async (status = 'ok') => { if (status !== lastStatus || Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

/**
 * The plain text inside an `attributedBody` blob. Newer macOS versions leave `message.text` empty and keep the body
 * only as an archived NSAttributedString in Apple's old "typedstream" format. This is a best-effort reader, not a
 * full decoder: it finds the first NSString in the stream, then the marker for "bytes follow" ('+'), then a length
 * (one byte, or 0x81 and two bytes, or 0x82 and four bytes, little-endian), then that many bytes of UTF-8.
 * Anything that does not fit exactly returns null, so the caller skips the message instead of passing on garbage.
 */
export function plainFromAttributedBody(blob) {
  try {
    if (!blob || blob.length < 24) return null;
    const b = Buffer.from(blob.buffer, blob.byteOffset, blob.length);
    if (b.indexOf('streamtyped') < 0 || b.indexOf('streamtyped') > 8) return null;
    const cls = b.indexOf('NSString'); if (cls < 0) return null;
    const plus = b.indexOf(0x2b, cls + 8); if (plus < 0 || plus - (cls + 8) > 12) return null;
    let p = plus + 1, len = b[p++];
    if (len === 0x81) { len = b.readUInt16LE(p); p += 2; } else if (len === 0x82) { len = b.readUInt32LE(p); p += 4; } else if (len === undefined || len >= 0x80) return null;
    if (!len || p + len > b.length) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(p, p + len));
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? null : text;
  } catch { return null; }
}

const kindOf = mime => /^image\//.test(mime || '') ? 'image' : /^video\//.test(mime || '') ? 'video' : /^audio\//.test(mime || '') ? 'audio' : 'document';
const clean = s => String(s || '').replace(/[\ufffc\ufffd]/g, '').trim();   // U+FFFC stands where an attachment sits in the text

/** One row of the query below to an item, or null for rows that are not messages a person wrote (reactions, group events, undecodable). */
export function toItem(row, attachmentMime, historyUntil = 0) {
  if (row.associated_message_type || row.item_type) return null;            // tapbacks and stickers; "left the group", renames
  const text = clean(row.text) || clean(plainFromAttributedBody(row.attributedBody));
  if (!text && attachmentMime === undefined) return null;
  const mine = !!row.is_from_me, group = row.style === 43 || row.members > 1;
  return { sourceId: row.guid || `rowid:${row.ROWID}`, threadId: row.chat_guid || row.chat_identifier || row.handle || undefined,
    author: mine ? 'me' : row.handle || undefined, authorName: mine ? 'Me' : row.handle || undefined,
    sourceTime: row.ms > 0 ? new Date(APPLE_EPOCH_MS + row.ms).toISOString() : undefined, direction: mine ? 'outgoing' : 'incoming', isGroup: group,
    kind: text ? 'text' : kindOf(attachmentMime), text,
    chatName: group ? row.display_name || (row.member_ids ? `Group with ${row.member_ids.split(',').join(', ')}` : undefined) : undefined,
    origin: row.ROWID <= historyUntil ? 'history' : undefined };
}

class NoAccess extends Error {}
/** Open the Messages database for reading only. Nothing in this file writes to it. */
async function open() {
  const file = OVERRIDE || path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
  const { DatabaseSync } = await import('node:sqlite');
  try { const db = new DatabaseSync(file, { readOnly: true }); db.prepare('SELECT 1 FROM message LIMIT 1').get(); return db; }
  catch (e) { if (/unable to open|authorization denied|not permitted|permission denied|not authorized/i.test(e.message)) throw new NoAccess(e.message); throw e; }
}

const QUERY = `SELECT m.ROWID, m.guid, m.text, m.attributedBody, m.is_from_me, m.associated_message_type, m.item_type, m.cache_has_attachments, ${MS} AS ms,
    h.id AS handle, c.ROWID AS chat_rowid, c.guid AS chat_guid, c.chat_identifier, c.display_name, c.style,
    (SELECT COUNT(*) FROM chat_handle_join x WHERE x.chat_id = c.ROWID) AS members,
    (SELECT GROUP_CONCAT(h2.id) FROM chat_handle_join x JOIN handle h2 ON h2.ROWID = x.handle_id WHERE x.chat_id = c.ROWID) AS member_ids
  FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
    LEFT JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = j.chat_id
  WHERE m.ROWID > ? GROUP BY m.ROWID ORDER BY m.ROWID LIMIT 200`;

async function pass() {
  if (!fs.existsSync(flagFile)) { await heartbeat('needs_login'); console.log('Not switched on yet. To let Clockwork read your texts: clockwork connect imessage'); return; }
  if (process.platform !== 'darwin' && !OVERRIDE) { await heartbeat('error'); console.error('The iMessage extractor only works on a Mac: Messages keeps its database there. Switch it off with: clockwork disable imessage'); process.exitCode = 1; return 'stop'; }
  let db; try { db = await open(); } catch (e) { if (!(e instanceof NoAccess)) throw e; await heartbeat('needs_login'); console.error(ACCESS_HELP); return; }
  try {
    const state = loadState();
    if (state.last === undefined) {                               // first run: start a day back, and call everything already there history
      const cutoff = Date.now() - APPLE_EPOCH_MS - FIRST_MS;
      const top = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS n FROM message').get().n;
      const from = db.prepare(`SELECT MIN(m.ROWID) AS n FROM message m WHERE ${MS} >= ?`).get(cutoff).n;
      state.last = from ? from - 1 : top; state.historyUntil = top;
    }
    const mimeOf = db.prepare('SELECT a.mime_type AS mime FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id WHERE j.message_id = ? ORDER BY a.ROWID LIMIT 1');
    let sent = 0, fresh = 0, skipped = 0;
    for (;;) {
      const rows = db.prepare(QUERY).all(state.last); if (!rows.length) break;
      const items = [];
      for (const row of rows) {
        const att = row.cache_has_attachments ? mimeOf.get(row.ROWID) : undefined;
        const it = toItem(row, att ? att.mime ?? null : undefined, state.historyUntil);
        if (it) items.push(it); else if (!row.associated_message_type && !row.item_type) skipped++;
      }
      const r = await send(items); sent += items.length; fresh += r.new || 0;
      state.last = rows.at(-1).ROWID; saveState(state);            // only after the core has these
    }
    if (sent || skipped) console.log(`pass done: sent ${sent}, ${fresh} new${skipped ? `, ${skipped} skipped (no readable content)` : ''}`);
    if (!sent) { if (lastStatus !== 'ok' || Date.now() - lastContact > 5 * 60_000) await send([]); saveState(state); }   // nothing new: report in, then remember where we are
  } finally { db.close(); }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    let stop; try { stop = await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE || stop) break;
    await sleep(POLL_S * 1000);
  }
}
