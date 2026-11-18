// The Mastodon extractor against a stand-in Mastodon server and a stand-in core. No real server, no real items, made-up people.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plain } from './main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), iso = agoSeconds => new Date(Date.now() - agoSeconds * 1000).toISOString();
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const TOKEN = 'token-for-tests-not-real', big = (a, b) => (BigInt(a) > BigInt(b) ? 1 : -1);
const DANA = { id: '11', username: 'dana', acct: 'dana', display_name: 'Dana', url: 'https://social.example.invalid/@dana' };
const SAM = { id: '12', username: 'sam', acct: 'sam@other.example.invalid', display_name: '', url: 'https://other.example.invalid/@sam' };
const status = (id, account, content, ago, extra = {}) => ({ id, uri: `https://social.example.invalid/statuses/${id}`, url: `https://social.example.invalid/@x/${id}`, created_at: iso(ago), account, content,
  visibility: 'public', spoiler_text: '', in_reply_to_id: null, reblog: null, media_attachments: [], mentions: [], ...extra });
const note = (id, type, account, ago, st) => ({ id, type, group_key: 'ungrouped-' + id, created_at: iso(ago), account, ...(st ? { status: st } : {}) });

test('turns Mastodon HTML into plain text', () => {
  assert.equal(plain('<p>Tea &amp; cake at 4?<br />Bring <a href="https://example.invalid/x"><span class="invisible">https://</span><span class="ellipsis">example.invalid/x</span></a></p><p>&lt;3 &#39;yes&#39; &#x1F600;</p>'),
    "Tea & cake at 4?\nBring https://example.invalid/x\n\n<3 'yes' \u{1F600}");
});

test('reads notifications once, pages forward from the last one, respects rate limits, and only ever sends GET', async () => {
  const calls = [], got = [], asked = []; let limited = false, accept = TOKEN, scarce = false;
  const notifications = [
    note('1001', 'mention', DANA, 3 * 86400, status('501', DANA, '<p>too old for the first run</p>', 3 * 86400)),
    note('1002', 'mention', DANA, 3600, status('502', DANA, '<p><span class="h-card"><a href="https://social.example.invalid/@me">@<span>me</span></a></span> are you free on Thursday?<br>I have two tickets &amp; a spare seat</p>', 3600, { in_reply_to_id: '400', visibility: 'direct' })),
    note('1003', 'favourite', SAM, 3000, status('400', DANA, '<p>liked</p>', 9000)),
    note('1004', 'status', SAM, 1800, status('503', SAM, '', 1800, { url: 'https://other.example.invalid/@sam/503', media_attachments: [{ type: 'image' }] })),
    note('1005', 'poll', DANA, 900, status('504', DANA, '<p>Which day suits everyone?</p>', 90000, { poll: { id: '9', expired: true } })),
    note('1006', 'follow_request', SAM, 600),
    note('1007', 'quote', DANA, 300, status('505', DANA, '<p>this is exactly right</p>', 300, { spoiler_text: 'long thread' })),
    note('1008', 'admin.sign_up', SAM, 200)];
  const home = [status('601', DANA, '<p>the library is closed on Monday</p>', 500), status('602', SAM, '', 400, { reblog: status('505', DANA, '<p>this is exactly right</p>', 300, { spoiler_text: 'long thread' }) }),
    status('603', SAM, '<p>first of a thread</p>', 200)];
  const masto = await listen((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.searchParams; calls.push(`${req.method} ${u.pathname}`); asked.push(u.search);
    const answer = (code, j, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'x-ratelimit-limit': '300', 'x-ratelimit-remaining': scarce ? '2' : '250', 'x-ratelimit-reset': iso(-1), ...headers }); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== 'Bearer ' + accept) return answer(401, { error: 'The access token is invalid' });
    const page = all => { const lim = Number(p.get('limit') || 40); let l = all.filter(e => !p.getAll('exclude_types[]').includes(e.type)).sort((a, b) => big(b.id, a.id));
      if (p.get('max_id')) l = l.filter(e => big(p.get('max_id'), e.id) > 0);
      if (p.get('since_id')) l = l.filter(e => big(e.id, p.get('since_id')) > 0);
      return p.get('min_id') ? l.filter(e => big(e.id, p.get('min_id')) > 0).slice(-lim) : l.slice(0, lim); };
    if (u.pathname === '/api/v1/notifications') { if (!limited) { limited = true; return answer(429, { error: 'Too many requests' }, { 'x-ratelimit-remaining': '0' }); } return answer(200, page(notifications)); }
    if (u.pathname === '/api/v1/timelines/home') return answer(200, page(home));
    answer(404, { error: 'Not found' });
  });
  const core = await listen((req, res, body) => { assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(body); assert.equal(j.source, 'mastodon'); got.push(j);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-mastodon-')); let output = '';
  const run = () => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data,
      CLOCKWORK_MASTODON_API: `http://127.0.0.1:${masto.address().port}`, CLOCKWORK_MASTODON_PACE_MS: '0' } });
    let err = ''; c.stderr.on('data', d => { err += d; output += d; }); c.stdout.on('data', d => output += d); c.on('exit', code => { got.ran = got.splice(0); ok({ code, err }); }); });
  const items = () => got.ran.flatMap(j => j.events), state = () => got.ran.at(-1).status, save = (name, text) => fs.writeFileSync(path.join(data, name), text, { mode: 0o600 });
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(state(), 'needs_login', 'nothing saved yet: says so and contacts nobody'); assert.deepEqual(calls, []);
    save('instance', 'social.example.invalid/\n');
    r = await run(); assert.equal(state(), 'needs_login', 'an address but no token'); assert.deepEqual(calls, []);
    save('token', 'a-revoked-token-not-real\n');
    r = await run(); assert.equal(state(), 'needs_login', 'the server refused the token'); assert.equal(calls.length, 1);
    r = await run(); assert.equal(state(), 'needs_login'); assert.equal(calls.length, 1, 'a refused token is not tried again until the token file changes');

    await new Promise(ok => setTimeout(ok, 20)); save('token', TOKEN + '\n'); const t0 = Date.now();
    r = await run(); assert.equal(r.err, ''); const a = items(), by = t => a.find(e => e.text.includes(t));
    assert.equal(state(), 'ok'); assert.ok(limited && Date.now() - t0 >= 900, 'the 429 was waited out until the time the server gave');
    assert.deepEqual(a.map(e => e.sourceId), ['social.example.invalid:status:502', 'social.example.invalid:status:503', 'social.example.invalid:notification:1005', 'social.example.invalid:notification:1006', 'social.example.invalid:status:505'],
      'the last day, oldest first; favourites and admin notices are skipped');
    assert.ok(a.every(e => e.origin === 'history'), 'the first run is marked as history');
    assert.deepEqual({ ...by('Thursday') }, { sourceId: 'social.example.invalid:status:502', threadId: 'social.example.invalid:status:400', author: 'dana@social.example.invalid', authorName: 'Dana', sourceTime: notifications[1].status.created_at,
      direction: 'incoming', isGroup: false, kind: 'text', text: '@me are you free on Thursday?\nI have two tickets & a spare seat', chatName: 'Mastodon mention', origin: 'history', url: 'https://social.example.invalid/@x/502' });
    assert.equal(a[1].kind, 'image'); assert.equal(a[1].text, ''); assert.equal(a[1].author, 'sam@other.example.invalid'); assert.equal(a[1].authorName, 'sam'); assert.equal(a[1].url, 'https://other.example.invalid/@sam/503');
    assert.equal(by('Which day').text, 'A poll you voted in or created has ended: Which day suits everyone?'); assert.equal(by('Which day').sourceTime, notifications[4].created_at);
    assert.equal(by('asked to follow').text, 'sam (@sam@other.example.invalid) asked to follow you.'); assert.equal(by('asked to follow').url, SAM.url);
    assert.equal(by('exactly right').text, '[long thread]\nthis is exactly right'); assert.equal(by('exactly right').chatName, 'Mastodon quote');
    assert.match(decodeURIComponent(asked.at(-1)), /exclude_types\[\]=favourite&exclude_types\[\]=reblog&exclude_types\[\]=follow&exclude_types\[\]=update/);

    // Second pass: asks only for what came after the last notification it saw, and sends nothing twice.
    notifications.push(note('1009', 'mention', SAM, 1, status('506', SAM, '<p>see you there</p>', 1)));
    r = await run(); assert.equal(r.err, ''); assert.deepEqual(items().map(e => e.text), ['see you there']); assert.equal(items()[0].origin, undefined);
    assert.match(asked.at(-1), /min_id=1008/, 'admin notices are skipped but still move the place it reads from');
    // The server says few calls are left: the pass still works (the wait before the next call is not measured here).
    scarce = true; const before = calls.length; r = await run(); assert.deepEqual(items(), [], 'a pass with nothing new sends only heartbeats'); assert.ok(got.ran.length >= 1); assert.equal(calls.length, before + 1); assert.match(asked.at(-1), /min_id=1009/);
    scarce = false;

    // The home timeline is off unless asked for.
    assert.ok(!calls.some(c => c.includes('timelines'))); save('settings.json', '{ "timeline": true }');
    r = await run(); assert.equal(r.err, '');
    assert.deepEqual(items().map(e => [e.sourceId, e.text, e.chatName, e.isGroup, e.origin]), [['social.example.invalid:status:601', 'the library is closed on Monday', 'Mastodon home timeline', true, 'history'],
      ['social.example.invalid:status:603', 'first of a thread', 'Mastodon home timeline', true, 'history']], 'a boost of a post already sent as a notification is not sent again');
    r = await run(); assert.deepEqual(items(), []); assert.match(asked.at(-1), /min_id=603/);

    // The token is revoked later.
    accept = 'something-else';
    r = await run(); assert.equal(state(), 'needs_login'); assert.match(r.err, /http 401/);

    assert.deepEqual([...new Set(calls)].sort(), ['GET /api/v1/notifications', 'GET /api/v1/timelines/home'], 'only GET, only these two paths: nothing is posted, dismissed or cleared');
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600); assert.ok(!fs.readFileSync(path.join(data, 'state.json'), 'utf8').includes(TOKEN));
    for (const secret of [TOKEN, 'a-revoked-token']) assert.ok(!output.includes(secret), 'no token is ever printed');
  } finally { masto.close(); core.close(); masto.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('the program can only send GET', () => {
  const src = fs.readFileSync(path.join(HERE, 'main.mjs'), 'utf8');
  assert.deepEqual([...src.matchAll(/method: '([A-Z]+)'/g)].map(m => m[1]).sort(), ['GET', 'POST'], 'one GET to Mastodon and one POST, which is to Clockwork itself');
  assert.ok(!/dismiss|\/clear|markers/.test(src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*\*.*?\*\//gs, '')));
});
