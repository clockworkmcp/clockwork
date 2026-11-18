// The Outlook extractor against a stand-in Microsoft sign-in service, a stand-in Microsoft Graph and a stand-in core.
// No real Microsoft, no real mail.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), MIN = 60_000, CLIENT = '00000000-1111-2222-3333-444444444444';
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const close = (...servers) => { for (const s of servers) { s.close(); s.closeAllConnections(); } };

/** A stand-in for login.microsoftonline.com: the device code flow and token renewal, with a new refresh token on every use. */
async function fakeLogin() {
  const st = { calls: [], n: 0, refresh: null, access: null, pending: 1, decline: false, revoked: false };
  const issue = () => { st.n++; st.refresh = `refresh-secret-${st.n}`; st.access = `access-secret-${st.n}`; return { token_type: 'Bearer', scope: 'https://graph.microsoft.com/Mail.Read', expires_in: 3600, access_token: st.access, refresh_token: st.refresh }; };
  const server = await listen((req, res, body) => {
    const p = Object.fromEntries(new URLSearchParams(body)), what = /^\/([^/]+)\/oauth2\/v2\.0\/(devicecode|token)$/.exec(req.url);
    st.calls.push({ method: req.method, url: req.url, p });
    if (req.method !== 'POST' || !what || what[1] !== 'common' || p.client_id !== CLIENT || p.client_secret !== undefined) return json(res, 400, { error: 'invalid_request' });
    if (what[2] === 'devicecode') return p.scope === 'https://graph.microsoft.com/Mail.Read offline_access' ? json(res, 200, { device_code: 'device-secret-1', user_code: 'ABCD-EFGH', verification_uri: 'https://login.example.invalid/device', expires_in: 900, interval: 1, message: 'ignored' }) : json(res, 400, { error: 'invalid_scope' });
    if (p.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') { if (p.device_code !== 'device-secret-1') return json(res, 400, { error: 'bad_verification_code' });
      if (st.decline) return json(res, 400, { error: 'authorization_declined' }); if (st.pending-- > 0) return json(res, 400, { error: 'authorization_pending' }); return json(res, 200, issue()); }
    if (p.grant_type === 'refresh_token') return !st.revoked && p.refresh_token === st.refresh ? json(res, 200, issue()) : json(res, 400, { error: 'invalid_grant', error_description: 'AADSTS70000: made up for the test' });
    json(res, 400, { error: 'unsupported_grant_type' });
  });
  return { server, st, url: () => `http://127.0.0.1:${server.address().port}` };
}

/** A stand-in for Graph's inbox delta: a first round filtered by date and paged two at a time, then rounds of changes since a token. */
async function fakeGraph(login) {
  const st = { calls: [], box: [], seq: 0, changes: [], limitOnce: false, expireOnce: false, goneOnce: false };
  const add = m => { st.box.push({ ...m, seq: ++st.seq }); }, change = c => { st.changes.push({ ...c, seq: ++st.seq }); };
  const strip = ({ seq, ...m }) => m;
  const server = await listen((req, res) => {
    const u = new URL(req.url, 'http://x'), q = u.searchParams, base = `http://127.0.0.1:${server.address().port}/v1.0/me/mailFolders/inbox/messages/delta`;
    st.calls.push({ method: req.method, path: u.pathname, query: u.search, t: Date.now(), auth: req.headers.authorization, prefer: req.headers.prefer });
    if (req.method !== 'GET' || u.pathname !== '/v1.0/me/mailFolders/inbox/messages/delta') return json(res, 405, { error: { code: 'notAllowed' } });
    if (req.headers.authorization !== 'Bearer ' + login.st.access || st.expireOnce) { st.expireOnce = false; return json(res, 401, { error: { code: 'InvalidAuthenticationToken' } }); }
    if (st.limitOnce) { st.limitOnce = false; return json(res, 429, { error: { code: 'TooManyRequests' } }, { 'retry-after': '1' }); }
    if (q.has('$deltatoken')) { if (st.goneOnce) { st.goneOnce = false; return json(res, 410, { error: { code: 'SyncStateNotFound' } }); }
      const since = Number(q.get('$deltatoken')); return json(res, 200, { value: [...st.box, ...st.changes].filter(m => m.seq > since).map(strip), '@odata.deltaLink': `${base}?$deltatoken=${st.seq}` }); }
    let from, offset = 0, upTo = st.seq;
    if (q.has('$skiptoken')) [from, offset, upTo] = q.get('$skiptoken').split('_').map(Number);
    else { const f = /^receivedDateTime ge (\S+)$/.exec(q.get('$filter') || ''); if (!f || !q.get('$select')?.includes('conversationId')) return json(res, 400, { error: { code: 'BadRequest' } }); from = Date.parse(f[1]); }
    const all = st.box.filter(m => m.seq <= upTo && Date.parse(m.receivedDateTime) >= from).reverse(), value = all.slice(offset, offset + 2).map(strip);
    json(res, 200, offset + 2 < all.length ? { value, '@odata.nextLink': `${base}?$skiptoken=${from}_${offset + 2}_${upTo}` } : { value, '@odata.deltaLink': `${base}?$deltatoken=${upTo}` });
  });
  return { server, st, add, change, url: () => `http://127.0.0.1:${server.address().port}/v1.0` };
}

const mail = (id, ago, from, subject, text, extra = {}) => ({ '@odata.type': '#microsoft.graph.message', id, conversationId: 'conv-' + id, subject, bodyPreview: text.slice(0, 255), body: { contentType: 'text', content: text },
  from: { emailAddress: from }, sender: { emailAddress: from }, toRecipients: [{ emailAddress: { name: 'Me', address: 'me@example.invalid' } }], receivedDateTime: new Date(Date.now() - ago).toISOString().replace(/\.\d+Z/, 'Z'),
  webLink: `https://outlook.example.invalid/mail/${id}`, isDraft: false, hasAttachments: false, ...extra });
const dana = { name: 'Dana Example', address: 'Dana@Example.invalid' }, sam = { name: 'Sam Example', address: 'sam@example.invalid' }, meFrom = { name: 'Me', address: 'me@example.invalid' };

test('signs in with a device code, reads new inbox mail with delta queries, renews its key, and only ever reads', async () => {
  const login = await fakeLogin(), graph = await fakeGraph(login), got = [], stored = new Set(); let twice = 0;
  const core = await listen((req, res, body) => { assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(body); assert.equal(j.source, 'outlook'); got.push(j);
    let fresh = 0; for (const e of j.events) { if (stored.has(e.sourceId)) twice++; else { stored.add(e.sourceId); fresh++; } } json(res, 200, { received: j.events.length, new: fresh }); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-outlook-')), file = n => path.join(data, n), output = [];
  const run = (program = 'main.mjs', args = ['--once']) => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, program), ...args], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data,
      CLOCKWORK_OUTLOOK_GRAPH: graph.url(), CLOCKWORK_OUTLOOK_LOGIN: login.url(), CLOCKWORK_OUTLOOK_PACE_MS: '0' } });
    let err = '', out = ''; c.stderr.on('data', d => err += d); c.stdout.on('data', d => out += d); c.on('exit', code => { output.push(err, out); ok({ code, err, out }); }); });
  const items = () => got.flatMap(j => j.events), fresh = () => { got.length = 0; graph.st.calls.length = 0; login.st.calls.length = 0; twice = 0; };
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(got.at(-1).status, 'needs_login', 'no client.json: says so and contacts nobody');
    fs.writeFileSync(file('client.json'), JSON.stringify({ clientId: CLIENT, tenant: 'common' })); fresh();
    r = await run(); assert.equal(got.at(-1).status, 'needs_login', 'not signed in yet: says so'); assert.equal(graph.st.calls.length + login.st.calls.length, 0);

    // Sign-in: the address and the code are shown for the user to enter in their own browser; nothing secret is printed.
    r = await run('login.mjs', []); assert.equal(r.code, 0, r.err);
    assert.match(r.out, /https:\/\/login\.example\.invalid\/device/); assert.match(r.out, /ABCD-EFGH/);
    assert.deepEqual(login.st.calls.map(c => c.url), ['/common/oauth2/v2.0/devicecode', '/common/oauth2/v2.0/token', '/common/oauth2/v2.0/token'], 'asks once, then waits and asks again while the user is still signing in');
    assert.deepEqual(JSON.parse(fs.readFileSync(file('token.json'), 'utf8')).refresh_token, 'refresh-secret-1'); assert.equal(fs.statSync(file('token.json')).mode & 0o777, 0o600);

    // First pass: the last day of the inbox, a page at a time, marked as history.
    graph.add(mail('m1', 3 * 60 * MIN, dana, 'Invoice for March', 'Hello,\r\n\r\nthe invoice is attached.\r\n\r\n\r\n\r\nThanks', { hasAttachments: true }));
    graph.add(mail('m2', 2 * 60 * MIN, meFrom, 'Note to self', 'remember the keys')); graph.add(mail('m3', 60 * MIN, sam, 'Lunch on Friday?', 'x'.repeat(7000)));
    graph.add(mail('old', 3 * 24 * 60 * MIN, sam, 'Too old for the first run', 'last week')); graph.add(mail('draft', 30 * MIN, meFrom, 'Unfinished', 'not sent yet', { isDraft: true }));
    graph.add(mail('html', 20 * MIN, sam, null, '', { body: { contentType: 'html', content: '<html><head><style>p{}</style></head><body><p>Agenda &amp; notes</p><p>See you &lt;soon&gt;</p></body></html>' }, bodyPreview: '' }));
    fs.writeFileSync(file('me'), 'Me@Example.invalid\n'); fresh();
    r = await run(); assert.equal(r.err, ''); const a = items(), by = id => a.find(e => e.sourceId === id);
    assert.deepEqual(a.map(e => e.sourceId).sort(), ['html', 'm1', 'm2', 'm3']); assert.ok(a.every(e => e.origin === 'history'), 'the first run is marked as history');
    assert.deepEqual(by('m1'), { sourceId: 'm1', threadId: 'conv-m1', author: 'dana@example.invalid', authorName: 'Dana Example', sourceTime: new Date(graph.st.box[0].receivedDateTime).toISOString(), direction: 'incoming', isGroup: false, kind: 'text',
      text: 'Subject: Invoice for March\n\nHello,\n\nthe invoice is attached.\n\nThanks', url: 'https://outlook.example.invalid/mail/m1', origin: 'history', metadata: { subject: 'Invoice for March', to: 'me@example.invalid', attachments: true } });
    assert.equal(by('m2').direction, 'outgoing', 'mail from the user\'s own address is outgoing'); assert.equal(by('m3').text.length, 6000); assert.equal(by('m3').metadata.truncated, true);
    assert.equal(by('html').text, 'Subject: \n\nAgenda & notes\nSee you <soon>', 'a body that still came as HTML is turned into text');
    assert.equal(graph.st.calls.length, 3, 'three pages of two'); assert.match(decodeURIComponent(graph.st.calls[0].query), /\$filter=receivedDateTime ge \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/);
    for (const c of graph.st.calls) { assert.match(c.prefer, /outlook\.body-content-type="text"/); assert.match(c.prefer, /IdType="ImmutableId"/); }
    assert.equal(graph.st.calls[0].auth, 'Bearer access-secret-2', 'the key used for Graph is a renewed one');
    assert.equal(JSON.parse(fs.readFileSync(file('token.json'), 'utf8')).refresh_token, 'refresh-secret-2', 'the new refresh token replaces the old one'); assert.equal(fs.statSync(file('token.json')).mode & 0o777, 0o600);

    // Second pass: only what is new. Removals, read-state changes and old mail moved into the inbox are not new mail. Graph says "slow down" once.
    graph.add(mail('m4', -1000, dana, 'Re: Invoice for March', 'paid, thank you', { conversationId: 'conv-m1' })); graph.change({ id: 'm1', '@removed': { reason: 'deleted' } }); graph.change({ id: 'm3', isRead: true });
    graph.add(mail('moved', 5 * 24 * 60 * MIN, sam, 'Moved back into the inbox', 'from last week')); fresh(); graph.st.limitOnce = true;
    r = await run(); assert.equal(r.err, ''); assert.deepEqual(items().map(e => e.sourceId), ['m4']); assert.equal(items()[0].origin, undefined); assert.equal(items()[0].threadId, 'conv-m1'); assert.equal(twice, 0);
    assert.equal(graph.st.calls.length, 2); assert.ok(graph.st.calls[1].t - graph.st.calls[0].t >= 1000, `waited ${graph.st.calls[1].t - graph.st.calls[0].t} ms after a 429 with Retry-After: 1`);
    assert.match(graph.st.calls[0].query, /\$deltatoken=/, 'continues from the saved delta link');
    fresh(); r = await run(); assert.deepEqual(items(), [], 'a third pass with nothing new sends only heartbeats'); assert.ok(got.length >= 1); assert.equal(got.at(-1).status, 'ok');

    // A key that Graph no longer accepts is renewed once and the request repeated.
    graph.add(mail('m5', -2000, sam, 'One more', 'after the key ran out')); fresh(); graph.st.expireOnce = true;
    r = await run(); assert.equal(r.err, ''); assert.deepEqual(items().map(e => e.sourceId), ['m5']); assert.equal(login.st.calls.filter(c => c.p.grant_type === 'refresh_token').length, 2);

    // Graph forgets where we were (410): a new round starts from the newest mail seen. Mail may be offered again, under the same id, so the core keeps one copy.
    graph.add(mail('m6', -3000, dana, 'After the reset', 'still arrives')); fresh(); graph.st.goneOnce = true;
    r = await run(); assert.equal(r.err, ''); assert.ok(items().some(e => e.sourceId === 'm6')); assert.deepEqual([...stored].sort(), ['html', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    assert.match(decodeURIComponent(graph.st.calls[1].query), /\$filter=receivedDateTime ge /); assert.ok(items().every(e => ['m4', 'm5', 'm6'].includes(e.sourceId)), 'only the last few minutes are asked for again');
    fresh(); r = await run(); assert.deepEqual(items(), []); assert.equal(twice, 0);

    // Sign-in withdrawn: it says so and does not touch Graph.
    login.st.revoked = true; fresh();
    r = await run(); assert.equal(r.code, 0); assert.equal(got.at(-1).status, 'needs_login'); assert.equal(graph.st.calls.length, 0); assert.deepEqual(items(), []);

    assert.equal(fs.statSync(file('state.json')).mode & 0o777, 0o600);
    assert.ok(!/(refresh|access|device)-secret/.test(output.join('\n')), 'no token, refresh token or device code is ever printed');
    assert.ok(!/(refresh|access|device)-secret/.test(fs.readFileSync(file('state.json'), 'utf8')), 'and none is kept in the state file');
  } finally { close(login.server, graph.server, core); fs.rmSync(data, { recursive: true, force: true }); }
});

test('every request to Graph is a GET on the inbox delta address; only the sign-in service is ever sent a POST', async () => {
  const login = await fakeLogin(), graph = await fakeGraph(login), core = await listen((req, res, body) => json(res, 200, { received: JSON.parse(body).events.length, new: 0 }));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-outlook-')); login.st.pending = 0;
  const env = { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_OUTLOOK_GRAPH: graph.url(), CLOCKWORK_OUTLOOK_LOGIN: login.url(), CLOCKWORK_OUTLOOK_PACE_MS: '0' };
  const run = (program, args) => new Promise(ok => spawn(process.execPath, [path.join(HERE, program), ...args], { stdio: 'ignore', env }).on('exit', ok));
  try {
    fs.writeFileSync(path.join(data, 'client.json'), JSON.stringify({ clientId: CLIENT })); assert.equal(await run('login.mjs', []), 0, 'tenant defaults to common');
    for (let i = 0; i < 3; i++) { graph.add(mail('n' + i, MIN, sam, 'Hello ' + i, 'made up')); assert.equal(await run('main.mjs', ['--once']), 0); }
    assert.ok(graph.st.calls.length >= 3);
    for (const c of graph.st.calls) { assert.equal(c.method, 'GET'); assert.equal(c.path, '/v1.0/me/mailFolders/inbox/messages/delta'); }
    for (const c of login.st.calls) { assert.equal(c.method, 'POST'); assert.match(c.url, /^\/common\/oauth2\/v2\.0\/(devicecode|token)$/); assert.equal(c.p.client_secret, undefined); }
  } finally { close(login.server, graph.server, core); fs.rmSync(data, { recursive: true, force: true }); }
});

test('a declined sign-in saves nothing and fails plainly', async () => {
  const login = await fakeLogin(), data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-outlook-')); login.st.decline = true;
  try {
    fs.writeFileSync(path.join(data, 'client.json'), JSON.stringify({ clientId: CLIENT, tenant: 'common' }));
    const r = await new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'login.mjs')], { stdio: 'pipe', env: { PATH: process.env.PATH, CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_OUTLOOK_LOGIN: login.url() } });
      let err = ''; c.stderr.on('data', d => err += d); c.on('exit', code => ok({ code, err })); });
    assert.equal(r.code, 1); assert.match(r.err, /declined/); assert.ok(!fs.existsSync(path.join(data, 'token.json')));
  } finally { close(login.server); fs.rmSync(data, { recursive: true, force: true }); }
});

test('the code can only read: Graph is only ever sent GET, and the permissions asked for are Mail.Read and offline_access', async () => {
  const main = fs.readFileSync(path.join(HERE, 'main.mjs'), 'utf8'), signin = fs.readFileSync(path.join(HERE, 'login.mjs'), 'utf8');
  assert.deepEqual([...main.matchAll(/fetch\(([^,]+),\s*\{\s*method:\s*'(\w+)'/g)].map(m => `${m[2]} ${m[1]}`), ["POST CORE + '/ingest/events'", 'GET url']); assert.equal([...main.matchAll(/\bfetch\(/g)].length, 2);
  assert.equal([...signin.matchAll(/\bfetch\(/g)].length, 1); assert.match(signin, /fetch\(`\$\{LOGIN\}\/\$\{client\.tenant\}\/oauth2\/v2\.0\/\$\{what\}`/); assert.ok(!/graph\.microsoft\.com\/v1/.test(signin));
  assert.equal((await import('./login.mjs')).SCOPE, 'https://graph.microsoft.com/Mail.Read offline_access'); assert.ok(!/client_secret|Mail\.ReadWrite|Mail\.Send/.test(main + signin));
});

test('a first run cut short carries on where it stopped, still as history, and a long-running delta is started afresh', async () => {
  const login = await fakeLogin(), graph = await fakeGraph(login), got = [];
  const core = await listen((req, res, body) => { const j = JSON.parse(body); got.push(...j.events); json(res, 200, { received: j.events.length, new: j.events.length }); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-outlook-')); login.st.pending = 0;
  const env = { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_OUTLOOK_GRAPH: graph.url(), CLOCKWORK_OUTLOOK_LOGIN: login.url(), CLOCKWORK_OUTLOOK_PACE_MS: '0' };
  const run = (program, args, more = {}) => new Promise(ok => spawn(process.execPath, [path.join(HERE, program), ...args], { stdio: 'ignore', env: { ...env, ...more } }).on('exit', ok));
  try {
    fs.writeFileSync(path.join(data, 'client.json'), JSON.stringify({ clientId: CLIENT, tenant: 'common' })); await run('login.mjs', []);
    for (let i = 0; i < 5; i++) graph.add(mail('h' + i, (60 - i * 10) * MIN, sam, 'Hello ' + i, 'made up'));
    await run('main.mjs', ['--once'], { CLOCKWORK_OUTLOOK_MAX_PAGES: '1' }); assert.equal(got.length, 2, 'one page of two');
    await run('main.mjs', ['--once']); assert.deepEqual(got.map(e => e.sourceId).sort(), ['h0', 'h1', 'h2', 'h3', 'h4']); assert.ok(got.every(e => e.origin === 'history'));
    graph.add(mail('late', -1000, sam, 'Later', 'made up')); got.length = 0; graph.st.calls.length = 0;
    await run('main.mjs', ['--once'], { CLOCKWORK_OUTLOOK_RENEW_AFTER: '1' });
    assert.match(decodeURIComponent(graph.st.calls[0].query), /\$filter=receivedDateTime ge /, 'a new round is started instead of using the old link'); assert.ok(got.some(e => e.sourceId === 'late'));
    assert.ok(got.every(e => e.origin === undefined && ['h4', 'late'].includes(e.sourceId)), 'reaching back only a few minutes');
  } finally { close(login.server, graph.server, core); fs.rmSync(data, { recursive: true, force: true }); }
});
