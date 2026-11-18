// The Discord extractor against a stand-in Discord API and a stand-in core. No real Discord, no real items.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), TOKEN = 'bot-token-for-tests-not-real';
const flake = agoMs => String((BigInt(Date.now() - agoMs) - 1420070400000n) << 22n), MIN = 60_000;
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const msg = (ago, author, content, extra = {}) => ({ id: flake(ago), type: 0, author, content, timestamp: new Date(Date.now() - ago).toISOString(), mentions: [], attachments: [], embeds: [], ...extra });

test('reads the channels the bot can see, slowly and within Discord\'s limits, and never asks Discord to change anything', async () => {
  const calls = [], got = []; let limitOnce = true, globalOnce = false;
  const me = { id: '1', username: 'me_user', global_name: 'Me' }, dana = { id: '2', username: 'dana_w', global_name: 'Dana' }, sam = { id: '3', username: 'sam_k', global_name: null }, bot = { id: '9', username: 'deploybot', bot: true };
  const msgs = {
    200: [msg(60 * MIN, dana, 'can you check the build <@1> <:party:999> in <#203>?', { mentions: [me] }), msg(50 * MIN, me, 'on it'), msg(3 * 24 * 60 * MIN, dana, 'too old for the first run'),
      msg(40 * MIN, sam, '', { type: 7 }), msg(30 * MIN, sam, '', { attachments: [{ filename: 'chart.png', content_type: 'image/png' }] }),
      msg(20 * MIN, bot, '', { embeds: [{ title: 'Deploy', description: 'finished without errors' }] }), msg(10 * MIN, sam, 'planning <t:1700000000:R> <@&555> <@!2>', { type: 19, mentions: [dana] })],
    201: [msg(5 * MIN, dana, 'in a channel the bot may not read')],
    203: Array.from({ length: 101 }, (_, i) => msg((120 - i) * MIN, sam, `note ${i + 1}`)) };
  const discord = await listen((req, res) => {
    const u = new URL(req.url, 'http://x'), route = u.pathname.replace(/^\/api\/v10/, ''), p = Object.fromEntries(u.searchParams), ch = /^\/channels\/(\d+)\/messages$/.exec(route)?.[1];
    calls.push({ method: req.method, route, t: Date.now(), auth: req.headers.authorization, agent: req.headers['user-agent'] });
    const answer = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bot ' + TOKEN) return answer(401, { message: '401: Unauthorized', code: 0 });
    if (route === '/users/@me/guilds') { if (globalOnce) { globalOnce = false; return answer(429, { message: 'You are being rate limited.', retry_after: 0.3, global: true }, { 'x-ratelimit-global': 'true', 'x-ratelimit-scope': 'global' }); }
      return answer(200, [{ id: '100', name: 'Test Server' }]); }
    if (route === '/guilds/100/channels') return answer(200, [{ id: '199', type: 4, name: 'Category' }, { id: '200', type: 0, name: 'general' }, { id: '201', type: 0, name: 'locked' }, { id: '202', type: 2, name: 'Voice' }, { id: '203', type: 5, name: 'news' }]);
    if (ch === '201') return answer(403, { message: 'Missing Access', code: 50001 });
    if (ch === '200' && limitOnce) { limitOnce = false; return answer(429, { message: 'You are being rate limited.', retry_after: 0.3, global: false }, { 'x-ratelimit-bucket': 'bucket-a', 'x-ratelimit-scope': 'user' }); }
    if (ch && msgs[ch]) { const page = msgs[ch].filter(m => BigInt(m.id) > BigInt(p.after)).sort((a, b) => BigInt(a.id) > BigInt(b.id) ? 1 : -1).slice(0, Number(p.limit)).reverse();   // newest first, as Discord does
      return answer(200, page, ch === '203' ? { 'x-ratelimit-bucket': 'bucket-b', 'x-ratelimit-limit': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.4' } : { 'x-ratelimit-bucket': 'bucket-a', 'x-ratelimit-remaining': '4', 'x-ratelimit-reset-after': '1' }); }
    answer(404, { message: 'Not Found' });
  });
  const core = await listen((req, res, body) => { assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(body); assert.equal(j.source, 'discord'); got.push(j);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-discord-'));
  const run = () => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data,
      CLOCKWORK_DISCORD_API: `http://127.0.0.1:${discord.address().port}/api/v10`, CLOCKWORK_DISCORD_PACE_MS: '0' } });
    let err = '', out = ''; c.stderr.on('data', d => err += d); c.stdout.on('data', d => out += d); c.on('exit', code => ok({ code, err, out })); });
  const items = () => got.flatMap(j => j.events), fresh = () => { got.length = 0; calls.length = 0; }, to = route => calls.filter(c => c.route === route);
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(got.at(-1).status, 'needs_login', 'no token yet: says so and reads nothing'); assert.deepEqual(calls, []);

    // First pass: the last day of every readable text channel, marked as history.
    fs.writeFileSync(path.join(data, 'token'), TOKEN + '\n'); fs.writeFileSync(path.join(data, 'me'), '1\n'); fresh();
    r = await run(); assert.equal(r.err, ''); const a = items(), by = t => a.find(e => e.text?.includes(t));
    assert.equal(a.length, 5 + 101, JSON.stringify(a.map(e => e.text).slice(0, 8)));
    assert.ok(a.every(e => e.origin === 'history'), 'the first read of a channel is marked as history');
    assert.equal(by('check the build').text, 'can you check the build @Me (you) :party: in #news?');
    assert.deepEqual({ ...by('check the build'), sourceTime: 0, origin: 0 }, { sourceId: `100:200:${msgs[200][0].id}`, threadId: '200', author: '2', authorName: 'Dana', sourceTime: 0, direction: 'incoming', isGroup: true, kind: 'text',
      text: 'can you check the build @Me (you) :party: in #news?', chatName: 'Test Server #general', origin: 0, url: `https://discord.com/channels/100/200/${msgs[200][0].id}` });
    assert.equal(by('check the build').sourceTime, msgs[200][0].timestamp);
    assert.equal(by('on it').direction, 'outgoing', 'what the user wrote themself is outgoing'); assert.ok(!by('too old'));
    assert.equal(a.find(e => e.kind === 'image').text, ''); assert.equal(by('Deploy').text, 'Deploy\nfinished without errors'); assert.equal(by('Deploy').authorName, 'deploybot');
    assert.equal(by('planning').text, 'planning 2023-11-14T22:13:20.000Z @role @Dana'); assert.equal(by('planning').authorName, 'sam_k');
    assert.equal(a.filter(e => e.threadId === '203').length, 101, 'a channel with more than one page is read to the end'); assert.equal(new Set(a.map(e => e.sourceId)).size, a.length);
    assert.ok(!by('may not read')); assert.equal(to('/channels/201/messages').length, 1, 'a channel that answers 403 is skipped without failing'); assert.equal(got.at(-1).status, 'ok');
    assert.equal(to('/channels/202/messages').length + to('/channels/199/messages').length, 0, 'voice channels and categories are not read');
    // Rate limits: after a 429 it waits as long as it was told, and it does not use a bucket that has nothing left before it refills.
    const general = to('/channels/200/messages'), news = to('/channels/203/messages');
    assert.equal(general.length, 2); assert.ok(general[1].t - general[0].t >= 300, `waited ${general[1].t - general[0].t} ms after a 429`);
    assert.equal(news.length, 2); assert.ok(news[1].t - news[0].t >= 400, `waited ${news[1].t - news[0].t} ms for the bucket to refill`);

    // Second pass: one new message, nothing sent twice. Discord's limit over everything stops every call for as long as it says.
    msgs[200].push(msg(-1000, dana, 'second thing')); msgs[201].push(msg(-1000, dana, 'still locked')); fresh(); globalOnce = true;
    r = await run(); assert.equal(r.err, ''); assert.deepEqual(items().map(e => e.text), ['second thing']); assert.equal(items()[0].origin, undefined);
    assert.ok(calls[1].t - calls[0].t >= 300, `waited ${calls[1].t - calls[0].t} ms after the limit over everything`);
    assert.equal(to('/channels/201/messages').length, 0, 'a channel that refused is left alone for a while');
    fresh(); r = await run(); assert.deepEqual(items(), [], 'a third pass with nothing new sends only heartbeats'); assert.ok(got.length >= 1);

    // An allow-list keeps it to the channels named.
    fs.writeFileSync(path.join(data, 'channels.txt'), '# only the news\n203   # news\n'); msgs[200].push(msg(-2000, dana, 'not on the list')); msgs[203].push(msg(-2000, sam, 'on the list')); fresh();
    r = await run(); assert.deepEqual(items().map(e => e.text), ['on the list']); assert.equal(to('/channels/200/messages').length, 0);
    fs.rmSync(path.join(data, 'channels.txt')); fresh(); r = await run(); assert.deepEqual(items().map(e => e.text), ['not on the list'], 'and nothing is lost for a channel that was off the list');

    // Messages that arrive with nothing in them (the bot may not see content): it says so, and picks them up once it may.
    const hidden = msg(-3000, dana, ''); msgs[200].push(hidden); fresh();
    r = await run(); assert.deepEqual(items(), []); assert.equal(got.at(-1).status, 'needs_intent'); assert.match(r.err, /Message Content Intent/);
    hidden.content = 'now readable'; fresh(); r = await run(); assert.deepEqual(items().map(e => e.text), ['now readable']); assert.equal(got.at(-1).status, 'ok');

    // A token Discord rejects: one call, then it stops and asks for a new one.
    fs.writeFileSync(path.join(data, 'token'), 'rejected-token-not-real\n'); fresh();
    r = await run(); assert.equal(r.code, 0); assert.equal(got.at(-1).status, 'needs_login'); assert.equal(calls.length, 1); assert.deepEqual(items(), []);
    assert.ok(!r.err.includes('rejected-token') && !r.out.includes('rejected-token'), 'the token is never printed');

    fresh(); fs.writeFileSync(path.join(data, 'token'), 'Bot ' + TOKEN + '\n'); r = await run(); assert.equal(got.at(-1).status, 'ok', 'a token pasted with "Bot " in front still works');
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600);
  } finally { discord.close(); core.close(); discord.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('every request to Discord is a GET with a bot token, on the three reading routes only', async () => {
  const seen = [];
  const discord = await listen((req, res) => { seen.push(req); const route = new URL(req.url, 'http://x').pathname;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(route === '/users/@me/guilds' ? [{ id: '100', name: 'Test Server' }] : route === '/guilds/100/channels' ? [{ id: '200', type: 0, name: 'general' }] : [msg(MIN, { id: '2', username: 'dana_w' }, 'hello there')])); });
  const core = await listen((req, res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: JSON.parse(body).events.length, new: 0 })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-discord-')); fs.writeFileSync(path.join(data, 'token'), TOKEN);
  try {
    for (let i = 0; i < 2; i++) await new Promise(ok => spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'ignore', env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`,
      CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_DISCORD_API: `http://127.0.0.1:${discord.address().port}`, CLOCKWORK_DISCORD_PACE_MS: '0' } }).on('exit', ok));
    assert.equal(seen.length, 6);
    for (const req of seen) { assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, 'Bot ' + TOKEN); assert.match(req.headers['user-agent'], /^DiscordBot \(/);
      assert.match(new URL(req.url, 'http://x').pathname, /^\/(users\/@me\/guilds|guilds\/\d+\/channels|channels\/\d+\/messages)$/); }
  } finally { discord.close(); core.close(); discord.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('the program has no way to write to Discord: no other method, no gateway', () => {
  const src = fs.readFileSync(path.join(HERE, 'main.mjs'), 'utf8'), discordCalls = [...src.matchAll(/fetch\(url,\s*\{\s*method:\s*'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(discordCalls, ['GET']); assert.equal([...src.matchAll(/\bfetch\(/g)].length, 2, 'one call to the core and one to Discord');
  assert.ok(!/WebSocket|gateway\.discord|wss:/.test(src));
});
