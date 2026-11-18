// The iMessage extractor against a made-up Messages database in a temp folder and a stand-in core.
// It never goes near the real ~/Library/Messages: every run is pointed at the fixture with CLOCKWORK_IMESSAGE_DB.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite'; import { fileURLToPath } from 'node:url';
import { plainFromAttributedBody } from './main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), APPLE = Date.UTC(2001, 0, 1);
const nanos = hoursAgo => BigInt(Date.now() - APPLE - hoursAgo * 3600_000) * 1000000n;      // how modern macOS stores a date
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** A hand-built typedstream NSAttributedString, laid out the way Messages writes `attributedBody`. */
function attributedBody(text) {
  const str = Buffer.from(text, 'utf8'), s = x => Buffer.from(x, 'latin1'), by = (...n) => Buffer.from(n);
  const len = n => n < 0x80 ? by(n) : by(0x81, n & 0xff, n >> 8);
  return Buffer.concat([by(0x04, 0x0b), s('streamtyped'), by(0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12), s('NSAttributedString'), by(0x00, 0x84, 0x84, 0x08), s('NSObject'), by(0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08),
    s('NSString'), by(0x01, 0x94, 0x84, 0x01, 0x2b), len(str.length), str,
    by(0x86, 0x84, 0x02, 0x69, 0x49, 0x01), len(text.length), by(0x92, 0x84, 0x84, 0x84, 0x0c), s('NSDictionary'), by(0x00, 0x94, 0x84, 0x01, 0x69, 0x01, 0x92, 0x84, 0x96, 0x96, 0x1d), s('__kIMMessagePartAttributeName'),
    by(0x86, 0x92, 0x84, 0x84, 0x84, 0x08), s('NSNumber'), by(0x00, 0x84, 0x84, 0x07), s('NSValue'), by(0x00, 0x94, 0x84, 0x01, 0x2a, 0x84, 0x99, 0x99, 0x00, 0x86, 0x86, 0x86)]);
}
const LONG = 'This one is long enough that its length no longer fits in a single byte, so the archive stores it as a marker and two more bytes. '.repeat(2).trim();

/** A database with the tables and columns the extractor reads, named as in the real one, holding made-up messages. */
function fixture(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, chat_identifier TEXT, service_name TEXT, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, attributedBody BLOB, handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER,
      is_from_me INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, PRIMARY KEY (chat_id, message_id));
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE (chat_id, handle_id));
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE (message_id, attachment_id));`);
  for (const [id, service] of [['+15550100', 'iMessage'], ['dana@example.invalid', 'iMessage'], ['+15550123', 'iMessage'], ['55501', 'SMS']]) db.prepare('INSERT INTO handle (id, service) VALUES (?, ?)').run(id, service);
  for (const [guid, style, ident, name] of [['iMessage;-;+15550100', 45, '+15550100', null], ['iMessage;+;chat1000', 43, 'chat1000', 'Weekend plans'], ['SMS;-;55501', 45, '55501', null], ['iMessage;+;chat2000', 43, 'chat2000', null]])
    db.prepare('INSERT INTO chat (guid, style, chat_identifier, display_name) VALUES (?, ?, ?, ?)').run(guid, style, ident, name);
  for (const [c, h] of [[1, 1], [2, 2], [2, 3], [3, 4], [4, 1], [4, 3]]) db.prepare('INSERT INTO chat_handle_join VALUES (?, ?)').run(c, h);
  return db;
}
let n = 0;
function add(db, chat, m) {
  const r = db.prepare('INSERT INTO message (guid, text, attributedBody, handle_id, service, date, is_from_me, associated_message_type, item_type, cache_has_attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.guid || `MADE-UP-${++n}`, m.text ?? null, m.body ?? null, m.handle ?? 0, m.service || 'iMessage', m.date, m.mine ? 1 : 0, m.assoc || 0, m.itemType || 0, m.mime !== undefined ? 1 : 0);
  db.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(chat, r.lastInsertRowid);
  if (m.mime !== undefined) { const a = db.prepare('INSERT INTO attachment (guid, filename, mime_type) VALUES (?, ?, ?)').run(`att-${n}`, '~/made/up/picture.jpg', m.mime); db.prepare('INSERT INTO message_attachment_join VALUES (?, ?)').run(r.lastInsertRowid, a.lastInsertRowid); }
}

async function setup() {
  const got = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-imessage-')), data = path.join(dir, 'data'), file = path.join(dir, 'fixture', 'chat.db');
  fs.mkdirSync(data); fs.mkdirSync(path.dirname(file));
  const core = await listen((req, res, body) => { assert.equal(req.method, 'POST'); assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(body); assert.equal(j.source, 'imessage'); got.push(j);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const run = (dbFile = file) => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, HOME: dir, NODE_NO_WARNINGS: '1', CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_IMESSAGE_DB: dbFile } });
    let err = '', out = ''; c.stderr.on('data', d => err += d); c.stdout.on('data', d => out += d); c.on('exit', code => ok({ code, err, out })); });
  const done = () => { core.close(); core.closeAllConnections(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { got, dir, data, file, run, done, items: () => got.flatMap(j => j.events) };
}

test('reads texts, groups, attachments and attributedBody; skips reactions; sends nothing twice; never changes the database', async () => {
  const t = await setup(), { got, data, file, run, items } = t;
  try {
    const db = fixture(file);
    add(db, 1, { handle: 1, date: nanos(72), text: 'too old for the first run' });
    add(db, 1, { handle: 1, date: nanos(2), text: 'Are you still coming to the made-up dinner on Friday?', guid: 'MADE-UP-DINNER' });
    add(db, 1, { handle: 1, date: nanos(1.9), text: 'yes, see you there', mine: true });
    add(db, 2, { handle: 3, date: nanos(1.8), text: 'I can bring the tent' });
    add(db, 2, { handle: 3, date: nanos(1.7), text: '\ufffc', mime: 'image/jpeg' });
    add(db, 2, { handle: 2, date: nanos(1.6), text: 'Loved “I can bring the tent”', assoc: 2000 });
    add(db, 1, { handle: 1, date: nanos(1.5), body: attributedBody('Decoded from the blob: café at 5? 🙂') });
    add(db, 1, { handle: 1, date: nanos(1.4), body: attributedBody(LONG) });
    add(db, 1, { handle: 1, date: nanos(1.3), body: Buffer.concat([Buffer.from('\x04\x0bstreamtyped'), crypto.randomBytes(60)]) });
    add(db, 3, { handle: 4, service: 'SMS', date: Math.round((Date.now() - APPLE) / 1000) - 3600, text: 'Your made-up code is 000000' });   // seconds, as old macOS wrote
    add(db, 2, { handle: 2, date: nanos(1.2), itemType: 2 });
    add(db, 4, { handle: 3, date: nanos(1.1), text: 'unnamed group message' });
    add(db, 2, { handle: 2, date: nanos(1), mime: null });
    db.close();
    const before = sha(file), files = fs.readdirSync(path.dirname(file));

    let r = await run(path.join(t.dir, 'not-there.db')); assert.equal(r.code, 0, r.err);
    assert.equal(got.at(-1).status, 'needs_login', 'not switched on: says so'); assert.equal(r.err, '', 'and does not even try to open a database'); assert.match(r.out, /clockwork connect imessage/); assert.deepEqual(items(), []);
    assert.ok(!fs.existsSync(path.join(data, 'state.json')));
    fs.writeFileSync(path.join(data, 'enabled'), 'yes'); got.length = 0;

    r = await run(); assert.equal(r.err, ''); const a = items(), by = s => a.find(e => e.text?.includes(s));
    assert.equal(a.length, 9, JSON.stringify(a.map(e => e.text)));
    assert.ok(a.every(e => e.origin === 'history'), 'the first run is marked as history'); assert.ok(!by('too old'));
    const dinner = by('dinner');
    assert.deepEqual({ ...dinner, sourceTime: undefined }, { sourceId: 'MADE-UP-DINNER', threadId: 'iMessage;-;+15550100', author: '+15550100', authorName: '+15550100', sourceTime: undefined,
      direction: 'incoming', isGroup: false, kind: 'text', text: 'Are you still coming to the made-up dinner on Friday?', origin: 'history' });
    assert.ok(Math.abs(Date.parse(dinner.sourceTime) - (Date.now() - 2 * 3600_000)) < 60_000, 'nanosecond dates are read');
    assert.equal(by('see you there').direction, 'outgoing'); assert.equal(by('see you there').author, 'me'); assert.equal(by('see you there').threadId, dinner.threadId);
    assert.deepEqual([by('tent').isGroup, by('tent').chatName, by('tent').author, by('tent').threadId], [true, 'Weekend plans', '+15550123', 'iMessage;+;chat1000']);
    assert.ok(!by('Loved'), 'reactions are skipped');
    assert.equal(by('Decoded').text, 'Decoded from the blob: café at 5? 🙂'); assert.equal(by('long enough').text, LONG); assert.ok(a.every(e => !/streamtyped|NSString/.test(e.text)), 'an unreadable blob is skipped, not passed on');
    const pics = a.filter(e => e.kind !== 'text'); assert.deepEqual(pics.map(e => [e.kind, e.text, e.author]), [['image', '', '+15550123'], ['document', '', 'dana@example.invalid']]);
    assert.equal(by('code is').author, '55501'); assert.ok(Math.abs(Date.parse(by('code is').sourceTime) - (Date.now() - 3600_000)) < 60_000, 'dates in seconds are read too');
    assert.equal(by('unnamed group').chatName, 'Group with +15550100, +15550123'); assert.equal(by('unnamed group').isGroup, true);
    assert.match(r.out, /sent 9, 9 new, 1 skipped/);
    assert.equal(new Set(a.map(e => e.sourceId)).size, 9);

    const w = new DatabaseSync(file); add(w, 1, { handle: 1, date: nanos(0), text: 'a new one' }); add(w, 1, { handle: 1, date: nanos(0), text: 'Liked “a new one”', assoc: 2001 }); w.close();
    const mid = sha(file); assert.notEqual(mid, before);
    got.length = 0; r = await run(); assert.equal(r.err, '');
    assert.deepEqual(items().map(e => [e.text, e.origin]), [['a new one', undefined]], 'only the new message, and it is not history');
    got.length = 0; r = await run(); assert.equal(r.err, ''); assert.deepEqual(items(), [], 'a third run sends nothing again'); assert.equal(got.at(-1).status, 'ok');

    assert.equal(sha(file), mid, 'the database is byte-for-byte what it was'); assert.deepEqual(fs.readdirSync(path.dirname(file)), files, 'and nothing was created next to it');
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600);
  } finally { t.done(); }
});

test('reads a database that Messages has open (write-ahead log) without changing the database or the log', async () => {
  const t = await setup(), { file, run, items } = t;
  try {
    const db = fixture(file); db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    add(db, 1, { handle: 1, date: nanos(1), text: 'still only in the log' });                    // the writer stays open, as Messages does
    fs.writeFileSync(path.join(t.data, 'enabled'), 'yes');
    const before = [sha(file), sha(file + '-wal')];
    const r = await run(); assert.equal(r.err, ''); assert.deepEqual(items().map(e => e.text), ['still only in the log']);
    assert.deepEqual([sha(file), sha(file + '-wal')], before);
    add(db, 1, { handle: 1, date: nanos(0), text: 'the writer can still write' }); db.close();
  } finally { t.done(); }
});

test('a database it may not open is reported as needs_login with the Full Disk Access instructions', { skip: process.getuid?.() === 0 }, async () => {
  const t = await setup(), { got, file, run, items } = t;
  try {
    fixture(file).close(); fs.chmodSync(file, 0o000); fs.writeFileSync(path.join(t.data, 'enabled'), 'yes');
    const r = await run(); assert.equal(r.code, 0); assert.equal(got.at(-1).status, 'needs_login'); assert.match(r.err, /Full Disk Access/); assert.deepEqual(items(), []);
    assert.ok(!fs.existsSync(path.join(t.data, 'state.json')));
  } finally { fs.chmodSync(file, 0o600); t.done(); }
});

test('the attributedBody reader returns null rather than guessing', () => {
  assert.equal(plainFromAttributedBody(attributedBody('short')), 'short');
  assert.equal(plainFromAttributedBody(attributedBody('x'.repeat(127))), 'x'.repeat(127)); assert.equal(plainFromAttributedBody(attributedBody('y'.repeat(128))), 'y'.repeat(128));
  assert.equal(plainFromAttributedBody(attributedBody('ünï'.repeat(400))), 'ünï'.repeat(400));
  const whole = attributedBody('cut off in the middle');
  assert.equal(plainFromAttributedBody(whole.subarray(0, whole.indexOf('cut off') + 5)), null, 'a length that runs past the end');
  assert.equal(plainFromAttributedBody(Buffer.from(whole.toString('latin1').replace('NSString', 'NSThingy'), 'latin1')), null);
  const bad = Buffer.from(whole); bad[bad.indexOf('cut off')] = 0xff; assert.equal(plainFromAttributedBody(bad), null, 'not valid UTF-8');
  assert.equal(plainFromAttributedBody(null), null); assert.equal(plainFromAttributedBody(Buffer.alloc(0)), null); assert.equal(plainFromAttributedBody(Buffer.from('plain bytes, not an archive at all')), null);
});

test('the program only ever reads: no statement that changes a database, no sending', () => {
  const src = fs.readFileSync(path.join(HERE, 'main.mjs'), 'utf8');
  assert.match(src, /readOnly: true/); assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH)\s/); assert.doesNotMatch(src, /osascript|child_process|AddressBook/);
});
