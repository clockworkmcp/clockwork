// The Slack extractor against a stand-in Slack API and a stand-in core. No real Slack, no real items.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), now = Date.now() / 1000, ts = ago => (now - ago).toFixed(6);
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });

test('reads direct messages and channels, follows thread replies, resolves names, never asks Slack to change anything', async () => {
  const calls = [], got = []; let limited = false;
  const msgs = { D1: [{ type: 'message', user: 'U2', ts: ts(3600), text: 'can you look at this today <@U1>?' }, { type: 'message', user: 'U1', ts: ts(3000), text: 'on it' },
      { type: 'message', user: 'U2', ts: ts(3 * 86400), text: 'too old for the first run' }],
    C1: [{ type: 'message', user: 'U3', ts: ts(7200), text: 'release is &lt;done&gt; see <https://example.invalid/r|notes> <!here>', thread_ts: ts(7200), reply_count: 1, latest_reply: ts(7000) },
      { type: 'message', subtype: 'channel_join', user: 'U3', ts: ts(7100), text: 'joined' },
      { type: 'message', bot_id: 'B1', username: 'alerts', ts: ts(600), text: '', attachments: [{ fallback: 'disk almost full' }] },
      { type: 'message', user: 'U3', ts: ts(500), files: [{ mimetype: 'image/png' }] }] };
  const replies = { [msgs.C1[0].ts]: [{ type: 'message', user: 'U2', ts: ts(7000), thread_ts: msgs.C1[0].ts, text: 'first reply' }] };
  const slack = await listen((req, res, body) => {
    const method = req.url.split('/').pop(), p = Object.fromEntries(new URLSearchParams(body)); calls.push(method);
    assert.equal(req.headers.authorization, 'Bearer xoxp-test-not-real');
    if (method === 'conversations.history' && !limited) { limited = true; res.writeHead(429, { 'retry-after': '1' }); return res.end('{}'); }
    const answer = { 'auth.test': () => ({ user_id: 'U1', team_id: 'T1', url: 'https://example.slack.com/' }),
      'users.conversations': () => ({ channels: [{ id: 'C1', name: 'general', is_channel: true }, { id: 'D1', is_im: true, user: 'U2' }] }),
      'users.info': () => ({ user: { real_name: { U1: 'Me', U2: 'Dana', U3: 'Sam' }[p.user] } }),
      'conversations.history': () => ({ messages: msgs[p.channel].filter(m => Number(m.ts) > Number(p.oldest)).reverse() }),
      'conversations.replies': () => ({ messages: [msgs.C1.find(m => m.ts === p.ts), ...(replies[p.ts] || [])].filter(m => m.ts === p.ts || Number(m.ts) > Number(p.oldest)) }) }[method];
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer ? { ok: true, ...answer() } : { ok: false, error: 'unknown_method' }));
  });
  const core = await listen((req, res, body) => { assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(body); assert.equal(j.source, 'slack'); got.push(j);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-slack-'));
  const run = () => new Promise(ok => { import('node:child_process').then(({ spawn }) => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data,
      CLOCKWORK_SLACK_API: `http://127.0.0.1:${slack.address().port}/api`, CLOCKWORK_SLACK_PACE_MS: '0', CLOCKWORK_SLACK_SWEEP_SECONDS: '0' } });
    let err = ''; c.stderr.on('data', d => err += d); c.on('exit', code => ok({ code, err })); }); });
  const items = () => got.flatMap(j => j.events);
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(got.at(-1).status, 'needs_login', 'no token yet: says so and reads nothing'); assert.deepEqual(calls, []);
    fs.writeFileSync(path.join(data, 'token'), 'xoxp-test-not-real\n'); got.length = 0;
    r = await run(); assert.equal(r.err, ''); const a = items(), by = t => a.find(e => e.text?.includes(t));
    assert.equal(a.length, 6, JSON.stringify(a.map(e => e.text)));
    assert.ok(a.every(e => e.origin === 'history'), 'the first read of a conversation is marked as history');
    assert.equal(by('look at this').text, 'can you look at this today @Me (you)?'); assert.equal(by('look at this').authorName, 'Dana'); assert.equal(by('look at this').isGroup, false);
    assert.equal(by('on it').direction, 'outgoing'); assert.ok(!by('too old'));
    assert.equal(by('release').text, 'release is <done> see notes (https://example.invalid/r) @here'); assert.equal(by('release').chatName, 'general');
    assert.equal(by('first reply').threadId, 'C1:' + msgs.C1[0].ts); assert.match(by('first reply').url, /^https:\/\/example\.slack\.com\/archives\/C1\/p\d+\?thread_ts=/);
    assert.equal(by('disk almost full').authorName, 'alerts'); assert.equal(a.find(e => e.kind === 'image').text, ''); assert.ok(!by('joined'));
    assert.equal(a[0].threadId, 'D1', 'direct messages are read first');
    // Second pass: one new direct message and one new reply in the old thread, and nothing is sent twice.
    msgs.D1.push({ type: 'message', user: 'U2', ts: ts(-1), text: 'second thing' });
    replies[msgs.C1[0].ts].push({ type: 'message', user: 'U3', ts: ts(-2), thread_ts: msgs.C1[0].ts, text: 'late reply' }); msgs.C1[0].latest_reply = ts(-2); msgs.C1[0].reply_count = 2;
    got.length = 0; r = await run(); assert.equal(r.err, '');
    assert.deepEqual(items().map(e => e.text).sort(), ['late reply', 'second thing']); assert.ok(items().every(e => e.origin === undefined));
    got.length = 0; r = await run(); assert.deepEqual(items(), [], 'a third pass with nothing new sends only heartbeats'); assert.ok(got.length >= 1);
    assert.deepEqual([...new Set(calls)].sort(), ['auth.test', 'conversations.history', 'conversations.replies', 'users.conversations', 'users.info'], 'only reading methods are ever called');
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600);
  } finally { slack.close(); core.close(); slack.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('the app definition asks for reading permissions only', () => {
  const scopes = JSON.parse(fs.readFileSync(path.join(HERE, 'slack-app.json'), 'utf8')).oauth_config.scopes;
  assert.deepEqual(Object.keys(scopes), ['user']); for (const s of scopes.user) assert.match(s, /:(history|read)$/);
});
