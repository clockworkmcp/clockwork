// The Bluesky extractor against a stand-in Bluesky service and a stand-in core. No real Bluesky, no real items, made-up people.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), iso = agoSeconds => new Date(Date.now() - agoSeconds * 1000).toISOString();
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop', ME = 'did:plc:me000', DANA = { did: 'did:plc:dana0', handle: 'dana.example.invalid', displayName: 'Dana' }, SAM = { did: 'did:plc:sam00', handle: 'sam.example.invalid' };
const post = (text, ago, extra = {}) => ({ $type: 'app.bsky.feed.post', text, createdAt: iso(ago + 2), ...extra });
const note = (reason, author, rk, ago, record) => ({ uri: `at://${author.did}/app.bsky.feed.post/${rk}`, cid: 'cid' + rk, author, reason, record, isRead: false, indexedAt: iso(ago) });

test('logs in with an app password, reads replies, mentions and quotes once, refreshes its session, and never changes anything on Bluesky', async () => {
  const calls = [], got = [], queries = []; let limited = false, n = 0, access = null, refresh = null;
  const root = { uri: `at://${ME}/app.bsky.feed.post/root1`, cid: 'cidroot1' };
  const notifications = [
    note('reply', DANA, 'r1', 3600, post('are you coming to the picnic on Sunday?', 3600, { reply: { root, parent: root } })),
    note('like', SAM, 'l1', 3000, { $type: 'app.bsky.feed.like', subject: root, createdAt: iso(3000) }),
    note('mention', SAM, 'm1', 1800, post('thanks to @me.example.invalid for the tip', 1800)),
    note('quote', DANA, 'q1', 900, post('', 900, { embed: { $type: 'app.bsky.embed.recordWithMedia', media: { $type: 'app.bsky.embed.images' } } })),
    note('follow', SAM, 'f1', 600, { $type: 'app.bsky.graph.follow', subject: ME, createdAt: iso(600) }),
    note('reply', SAM, 'old1', 3 * 86400, post('too old for the first run', 3 * 86400, { reply: { root, parent: root } }))];
  const feed = [{ post: { uri: `at://${SAM.did}/app.bsky.feed.post/t1`, cid: 'cidt1', author: SAM, record: post('the bakery on the corner has reopened', 400), indexedAt: iso(400) } },
    { post: { uri: `at://${ME}/app.bsky.feed.post/t2`, cid: 'cidt2', author: { did: ME, handle: 'me.example.invalid' }, record: post('my own post', 300), indexedAt: iso(300) } },
    { post: { uri: notifications[0].uri, cid: 'cidr1', author: DANA, record: notifications[0].record, indexedAt: notifications[0].indexedAt } }];
  const newest = list => [...list].sort((a, b) => Date.parse(b.indexedAt || b.post.indexedAt) - Date.parse(a.indexedAt || a.post.indexedAt));
  const bsky = await listen((req, res, body) => {
    const u = new URL(req.url, 'http://x'), nsid = u.pathname.replace('/xrpc/', ''), bearer = (req.headers.authorization || '').replace('Bearer ', ''); calls.push(`${req.method} ${nsid}`);
    const answer = (status, j, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(j)); };
    const session = () => { access = 'access-' + ++n; refresh = 'refresh-' + n; return { accessJwt: access, refreshJwt: refresh, did: ME, handle: 'me.example.invalid' }; };
    if (nsid === 'com.atproto.server.createSession') { const b = JSON.parse(body); assert.equal(b.identifier, 'me.example.invalid');
      return b.password === APP_PASSWORD ? answer(200, session()) : answer(401, { error: 'AuthenticationRequired', message: 'Invalid identifier or password' }); }
    if (nsid === 'com.atproto.server.refreshSession') return bearer === refresh ? answer(200, session()) : answer(400, { error: 'ExpiredToken', message: 'Token has expired' });
    if (bearer !== access) return answer(400, { error: 'ExpiredToken', message: 'Token has expired' });
    if (nsid === 'app.bsky.notification.listNotifications') { queries.push(u.search);
      if (!limited) { limited = true; return answer(429, { error: 'RateLimitExceeded' }, { 'retry-after': '1' }); }
      return answer(200, { notifications: newest(notifications), seenAt: iso(99999) }); }             // the stand-in ignores "reasons", so the extractor's own filter is tested too
    if (nsid === 'app.bsky.feed.getTimeline') return answer(200, { feed: newest(feed) });
    answer(404, { error: 'MethodNotImplemented' });
  });
  const core = await listen((req, res, body) => { assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(body); assert.equal(j.source, 'bluesky'); got.push(j);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-bluesky-')); let output = '';
  const run = () => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data,
      CLOCKWORK_BLUESKY_API: `http://127.0.0.1:${bsky.address().port}`, CLOCKWORK_BLUESKY_PACE_MS: '0' } });
    let err = ''; c.stderr.on('data', d => { err += d; output += d; }); c.stdout.on('data', d => output += d); c.on('exit', code => { got.ran = got.splice(0); ok({ code, err }); }); });
  const items = () => got.ran.flatMap(j => j.events), status = () => got.ran.at(-1).status, count = what => calls.filter(c => c.endsWith(what)).length;
  const saveLogin = j => fs.writeFileSync(path.join(data, 'login.json'), JSON.stringify(j), { mode: 0o600 });
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(status(), 'needs_login', 'no login yet: says so and contacts nobody'); assert.deepEqual(calls, []);
    saveLogin({ handle: 'me.example.invalid', appPassword: 'my-main-password-not-real' });
    r = await run(); assert.equal(status(), 'needs_login'); assert.deepEqual(calls, [], 'something that is not an app password is never sent anywhere'); assert.match(r.err, /app password/);
    saveLogin({ handle: 'me.example.invalid', appPassword: 'zzzz-zzzz-zzzz-zzzz' });
    r = await run(); assert.equal(status(), 'needs_login', 'a rejected app password'); assert.equal(count('createSession'), 1);
    r = await run(); assert.equal(status(), 'needs_login'); assert.equal(count('createSession'), 1, 'a rejected login is not tried again until login.json changes');

    await new Promise(ok => setTimeout(ok, 20)); saveLogin({ handle: '@me.example.invalid', appPassword: APP_PASSWORD });
    r = await run(); assert.equal(r.err, ''); const a = items(), by = t => a.find(e => e.text.includes(t));
    assert.equal(status(), 'ok'); assert.deepEqual(a.map(e => e.sourceId.split('/').pop()), ['r1', 'm1', 'q1'], 'replies, mentions and quotes from the last day, oldest first; likes and follows are skipped');
    assert.ok(a.every(e => e.origin === 'history'), 'the first run is marked as history'); assert.ok(limited, 'the 429 was waited out');
    assert.deepEqual({ ...by('picnic') }, { sourceId: `at://${DANA.did}/app.bsky.feed.post/r1`, threadId: root.uri, author: DANA.did, authorName: 'Dana', sourceTime: notifications[0].record.createdAt,
      direction: 'incoming', isGroup: false, kind: 'text', text: 'are you coming to the picnic on Sunday?', chatName: 'Bluesky reply', origin: 'history', url: `https://bsky.app/profile/${DANA.did}/post/r1` });
    assert.equal(by('for the tip').authorName, 'sam.example.invalid'); assert.equal(by('for the tip').threadId, by('for the tip').sourceId); assert.equal(by('for the tip').chatName, 'Bluesky mention');
    assert.equal(a[2].kind, 'image'); assert.equal(a[2].text, ''); assert.equal(a[2].chatName, 'Bluesky quote');
    assert.match(queries.at(-1), /reasons=reply&reasons=mention&reasons=quote/); assert.ok(!queries.some(q => /seenAt/.test(q)));
    assert.equal(count('createSession'), 2); assert.equal(count('refreshSession'), 0);

    // The access token runs out: the session is refreshed, and only what is new is sent.
    access = 'gone'; notifications.push(note('reply', DANA, 'r2', 1, post('never mind, found it', 1, { reply: { root, parent: root } })));
    r = await run(); assert.equal(r.err, ''); assert.deepEqual(items().map(e => e.text), ['never mind, found it']); assert.equal(items()[0].origin, undefined);
    assert.equal(count('refreshSession'), 1); assert.equal(count('createSession'), 2, 'refreshing does not need the app password again');
    r = await run(); assert.deepEqual(items(), [], 'a pass with nothing new sends only heartbeats'); assert.ok(got.ran.length >= 1); assert.equal(status(), 'ok');
    // Both tokens are gone (signed out elsewhere): it logs in again with the app password.
    access = 'gone'; refresh = 'gone';
    r = await run(); assert.equal(r.err, ''); assert.deepEqual(items(), []); assert.equal(count('createSession'), 3); assert.equal(status(), 'ok');

    // The home timeline is off unless asked for.
    assert.equal(count('getTimeline'), 0); saveLogin({ handle: 'me.example.invalid', appPassword: APP_PASSWORD, timeline: true });
    r = await run(); assert.equal(r.err, ''); assert.deepEqual(items().map(e => e.text), ['the bakery on the corner has reopened', 'my own post'], 'the reply already sent as a notification is not sent again');
    assert.deepEqual(items().map(e => [e.direction, e.chatName, e.isGroup, e.origin]), [['incoming', 'Bluesky home timeline', true, 'history'], ['outgoing', 'Bluesky home timeline', true, 'history']]);
    r = await run(); assert.deepEqual(items(), []);

    assert.deepEqual([...new Set(calls)].sort(), ['GET app.bsky.feed.getTimeline', 'GET app.bsky.notification.listNotifications', 'POST com.atproto.server.createSession', 'POST com.atproto.server.refreshSession'],
      'the only requests that are not GET are the two that log in; nothing is posted, liked, followed or marked as seen');
    const saved = fs.readFileSync(path.join(data, 'state.json'), 'utf8');
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600); assert.ok(saved.includes(refresh), 'the session is kept in the state file'); assert.ok(!saved.includes(APP_PASSWORD));
    for (const secret of [APP_PASSWORD, 'zzzz-zzzz', 'my-main-password', 'access-', 'refresh-']) assert.ok(!output.includes(secret), 'no password or token is ever printed');
  } finally { bsky.close(); core.close(); bsky.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('refuses to call anything that is not a reading method', async () => {
  const src = fs.readFileSync(path.join(HERE, 'main.mjs'), 'utf8');
  assert.ok(!/updateSeen|createRecord|putRecord|deleteRecord|applyWrites|chat\.bsky/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'no writing method is named in the code');
  assert.deepEqual([...new Set([...src.matchAll(/'((?:app|com|chat|tools)\.[a-zA-Z.]+)'/g)].map(m => m[1]))].sort(),
    ['app.bsky.feed.getTimeline', 'app.bsky.feed.post', 'app.bsky.notification.listNotifications', 'com.atproto.server.createSession', 'com.atproto.server.refreshSession'], 'two reading methods, two login methods, and the name of the post record type');
});
