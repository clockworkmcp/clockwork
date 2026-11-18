// The GitLab extractor against a stand-in GitLab API and a stand-in core. No real GitLab, no real to-do items.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), TOKEN = 'glpat-test-not-real', iso = agoS => new Date(Date.now() - agoS * 1000).toISOString();
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const coreStandIn = got => listen((req, res, body) => { assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(body); assert.equal(j.source, 'gitlab'); got.push(j);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
const runner = (data, core, env) => () => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
  env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_GITLAB_PACE_MS: '0', ...env } });
  let err = '', out = ''; c.stderr.on('data', d => err += d); c.stdout.on('data', d => out += d); c.on('exit', code => { assert.ok(!(err + out).includes(TOKEN), 'the token is never printed'); ok({ code, err }); }); });

const dana = { id: 11, username: 'dana-example', name: 'Dana Example' }, sam = { id: 12, username: 'sam-example', name: 'Sam Example' };
const project = { id: 5, name: 'widgets', path_with_namespace: 'acme/widgets', name_with_namespace: 'Acme / widgets' };
const todo = (id, action_name, agoS, author, target_type, target, body, extra = {}) => ({ id, project, author, action_name, target_type, target, body, state: 'pending', created_at: iso(agoS), updated_at: iso(agoS),
  target_url: `https://gitlab.example/acme/widgets/-/${target_type === 'Issue' ? 'issues' : 'merge_requests'}/${target.iid}`, ...extra });

test('reads pending to-do items page by page, never sends one twice, waits when told to, and only ever reads', async () => {
  const calls = [], allCalls = [], got = []; let limit = 'short';
  const mr7 = { id: 70, iid: 7, title: 'Add a retry to the uploader' };
  const todos = [
    todo(1, 'mentioned', 3600, dana, 'MergeRequest', mr7, '@me-example could you check the timeout?', { target_url: 'https://gitlab.example/acme/widgets/-/merge_requests/7#note_11' }),
    todo(2, 'assigned', 5 * 86400, sam, 'Issue', { id: 30, iid: 3, title: 'Login page is slow' }, 'Login page is slow'),
    todo(3, 'build_failed', 1800, dana, 'MergeRequest', mr7, 'Add a retry to the uploader'),
    todo(4, 'review_requested', 1200, sam, 'MergeRequest', { id: 90, iid: 9, title: 'Tidy the build script' }, 'Tidy the build script'),
    todo(5, 'approval_required', 600, sam, 'MergeRequest', { id: 91, iid: 10, title: 'Bump the base image' }, 'Bump the base image'),
    todo(6, 'ssh_key_expiring_soon', 300, dana, 'Key', { id: 400, title: 'laptop key' }, 'laptop key', { project: null, target_url: 'https://gitlab.example/-/user_settings/ssh_keys/400' })];
  const gitlab = await listen((req, res) => {
    const u = new URL(req.url, 'http://x'); const call = { method: req.method, path: u.pathname, page: u.searchParams.get('page') }; calls.push(call); allCalls.push(call);
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    assert.equal(req.headers.authorization, undefined);
    if (req.headers['private-token'] !== TOKEN) return json(401, { message: '401 Unauthorized' });
    if (limit === 'short') { limit = ''; return json(429, { message: 'Too Many Requests' }, { 'retry-after': '1' }); }
    if (limit === 'long') return json(429, { message: 'Too Many Requests' }, { 'retry-after': '3600' });
    assert.equal(u.pathname, '/api/v4/todos'); assert.equal(u.searchParams.get('state'), 'pending');
    const page = Number(u.searchParams.get('page')), size = 4, slice = todos.slice((page - 1) * size, page * size);      // the stand-in hands out four per page
    json(200, slice, { 'x-page': String(page), 'x-next-page': page * size < todos.length ? String(page + 1) : '' });
  });
  const core = await coreStandIn(got), data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-gitlab-'));
  const once = runner(data, core, { CLOCKWORK_GITLAB_API: `http://127.0.0.1:${gitlab.address().port}/api/v4` }), run = () => { got.length = 0; return once(); };
  const items = () => got.flatMap(j => j.events);
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(got.at(-1).status, 'needs_login', 'no token yet: says so and reads nothing'); assert.deepEqual(calls, []);
    fs.writeFileSync(path.join(data, 'token'), 'glpat-revoked-not-real\n');
    r = await run(); assert.equal(got.at(-1).status, 'needs_login', 'a token GitLab rejects'); assert.deepEqual(items(), []); assert.equal(calls.length, 1); assert.ok(!fs.existsSync(path.join(data, 'state.json')));

    // First real run: a short "too many requests" is waited out, then everything pending arrives as history, both pages.
    fs.writeFileSync(path.join(data, 'token'), TOKEN + '\n'); calls.length = 0;
    r = await run(); assert.equal(r.err, ''); assert.equal(got.at(-1).status, 'ok'); const a = items(), by = id => a.find(e => e.sourceId.startsWith(id + ':'));
    assert.deepEqual(a.map(e => e.sourceId.split(':')[0]), ['2', '1', '3', '4', '5', '6'], 'oldest first');
    assert.ok(a.every(e => e.origin === 'history' && e.direction === 'incoming' && e.kind === 'text'));
    assert.deepEqual(by(1), { sourceId: '1:' + todos[0].updated_at, threadId: 'acme/widgets:MergeRequest:7', author: 'dana-example', authorName: 'Dana Example', sourceTime: todos[0].updated_at,
      direction: 'incoming', isGroup: true, kind: 'text', text: '[mentioned] Merge request !7: Add a retry to the uploader\n\n@me-example could you check the timeout?', chatName: 'acme/widgets', origin: 'history',
      url: 'https://gitlab.example/acme/widgets/-/merge_requests/7#note_11' });
    assert.equal(by(2).text, '[assigned] Issue #3: Login page is slow', 'a body that only repeats the title is left out');
    assert.equal(by(3).text, '[build_failed] Merge request !7: Add a retry to the uploader'); assert.equal(by(3).threadId, by(1).threadId, 'to-dos about one merge request share a thread');
    assert.match(by(4).text, /^\[review_requested\] Merge request !9: /); assert.match(by(5).text, /^\[approval_required\] /);
    assert.equal(by(6).text, '[ssh_key_expiring_soon] SSH key: laptop key'); assert.equal(by(6).chatName, undefined); assert.equal(by(6).isGroup, false); assert.equal(by(6).threadId, 'user:Key:400');
    assert.deepEqual(calls.map(c => c.page), ['1', '1', '2'], 'one try that was told to wait, then two pages');

    calls.length = 0; r = await run(); assert.equal(r.err, ''); assert.deepEqual(items(), [], 'a second run with nothing new sends only heartbeats'); assert.ok(got.length >= 1);

    // One to-do is updated, one is new, one was ticked off in GitLab by the user: two items, and the ticked one is simply gone.
    const before = by(1).sourceId; todos[0].updated_at = iso(-1); todos[0].body = 'One more thing: the test is flaky.';
    todos.splice(1, 1); todos.push(todo(7, 'directly_addressed', -2, sam, 'Issue', { id: 31, iid: 4, title: 'Docs are out of date' }, '@me-example can you own this?'));
    r = await run(); assert.equal(r.err, ''); const b = items();
    assert.deepEqual(b.map(e => e.sourceId.split(':')[0]), ['1', '7']); assert.ok(b.every(e => e.origin === undefined), 'only the first run is history');
    assert.notEqual(b[0].sourceId, before); assert.match(b[0].text, /flaky\.$/); assert.equal(b[1].text, '[directly_addressed] Issue #4: Docs are out of date\n\n@me-example can you own this?');
    r = await run(); assert.deepEqual(items(), [], 'and nothing is sent twice');

    // A long rate limit: one call, the pass ends, and the next run stays away.
    limit = 'long'; calls.length = 0; r = await run(); assert.equal(calls.length, 1); assert.equal(got.at(-1).status, 'rate_limited'); assert.match(r.err, /slow down/);
    limit = ''; r = await run(); assert.equal(calls.length, 1, 'no further call before the time GitLab gave'); assert.equal(got.at(-1).status, 'rate_limited');

    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600); assert.ok(!fs.readFileSync(path.join(data, 'state.json'), 'utf8').includes(TOKEN));
  } finally { gitlab.close(); core.close(); gitlab.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
  assert.ok(allCalls.length >= 8 && allCalls.every(c => c.method === 'GET' && c.path === '/api/v4/todos'), 'every request to GitLab was a GET of the to-do list: nothing is marked as done');
});

test('a GitLab of your own is named in the host file and must be https; items wait for the core', async () => {
  const got = [], paths = []; let up = false;
  const core = await listen((req, res, body) => { if (!up && JSON.parse(body).events.length) { res.writeHead(500); return res.end('{}'); } got.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"received":0,"new":0}'); });
  const gitlab = await listen((req, res) => { paths.push(`${req.method} ${req.url.split('?')[0]}`); res.writeHead(200, { 'content-type': 'application/json' });      // no paging headers at all, as gitlab.com sometimes does
    res.end(JSON.stringify([todo(1, 'marked', 60, dana, 'Issue', { id: 30, iid: 3, title: 'Made-up title' }, 'Made-up title')])); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-gitlab-')), run = runner(data, core, {});
  try {
    fs.writeFileSync(path.join(data, 'token'), TOKEN); fs.writeFileSync(path.join(data, 'host'), 'http://gitlab.example\n');
    assert.match((await run()).err, /must start with https/); assert.equal(got.at(-1).status, 'error'); assert.deepEqual(paths, []);
    fs.writeFileSync(path.join(data, 'host'), `http://127.0.0.1:${gitlab.address().port}/\n`);
    assert.match((await run()).err, /core answered 500/); assert.ok(!fs.existsSync(path.join(data, 'state.json')), 'nothing is remembered until the core has the items');
    up = true; got.length = 0; assert.equal((await run()).err, ''); assert.deepEqual(got.flatMap(j => j.events).map(e => e.text), ['[marked] Issue #3: Made-up title'], 'the item is sent on the next run');
    assert.deepEqual([...new Set(paths)], ['GET /api/v4/todos']);
  } finally { gitlab.close(); core.close(); gitlab.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});
