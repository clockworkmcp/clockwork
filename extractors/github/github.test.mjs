// The GitHub extractor against a stand-in GitHub API and a stand-in core. No real GitHub, no real notifications.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { htmlUrl } from './main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), TOKEN = 'ghp_test_not_real', iso = agoS => new Date(Math.floor(Date.now() / 1000 - agoS) * 1000).toISOString().replace('.000Z', 'Z');
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const wait = ms => new Promise(r => setTimeout(r, ms));

test('reads notifications, adds the latest comment, never sends one twice, obeys GitHub about pace, and only ever reads', async () => {
  const calls = [], allCalls = [], got = []; let limit = 'short', poll = '0', modified = 'Mon, 02 Nov 2026 10:00:00 GMT', api, threads, bodies;
  const github = await listen((req, res) => {
    const u = new URL(req.url, 'http://x'), route = u.pathname.replace('/api/v3', ''), call = { method: req.method, route, since: req.headers['if-modified-since'] }; calls.push(call); allCalls.push(call);
    assert.ok(req.headers['user-agent'], 'GitHub rejects calls without a User-Agent');
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return json(401, { message: 'Bad credentials' });
    if (limit === 'short') { limit = ''; return json(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '1' }); }
    if (limit === 'long') return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
    if (route === '/notifications') {
      assert.equal(u.searchParams.get('all'), 'true'); const head = { 'last-modified': modified, 'x-poll-interval': poll };
      if (req.headers['if-modified-since'] === modified) { res.writeHead(304, head); return res.end(); }
      return json(200, threads.filter(n => Date.parse(n.updated_at) > Date.parse(u.searchParams.get('since'))), head);
    }
    return bodies[route] ? json(200, bodies[route]) : json(404, { message: 'Not Found' });
  });
  api = `http://127.0.0.1:${github.address().port}/api/v3`;
  const repo = (name, extra = {}) => ({ full_name: name, html_url: `https://github.example/${name}`, owner: { login: name.split('/')[0] }, ...extra });
  const thread = (id, reason, agoS, name, type, title, url, latest = url) => ({ id: String(id), unread: true, reason, updated_at: iso(agoS), last_read_at: null, repository: repo(name),
    subject: { title, type, url: url && api + url, latest_comment_url: latest && (latest.startsWith('http') ? latest : api + latest) }, url: `${api}/notifications/threads/${id}` });
  threads = [
    thread(100, 'subscribed', 3 * 86400, 'acme/widgets', 'Issue', 'Too old for the first run', '/repos/acme/widgets/issues/1'),
    thread(101, 'mention', 3600, 'acme/widgets', 'Issue', 'Widget crashes on empty input', '/repos/acme/widgets/issues/12', '/repos/acme/widgets/issues/comments/501'),
    thread(102, 'review_requested', 3000, 'acme/widgets', 'PullRequest', 'Add a retry to the uploader', '/repos/acme/widgets/pulls/7'),
    thread(103, 'ci_activity', 2400, 'acme/widgets', 'CheckSuite', 'Tests workflow run failed for main branch', null),
    thread(104, 'security_alert', 1800, 'acme/vault', 'RepositoryVulnerabilityAlert', 'Potential security vulnerability found in a dependency', null),
    thread(105, 'assign', 1200, 'acme/vault', 'Issue', 'Rotate the staging keys', '/repos/acme/vault/issues/3', '/repos/acme/vault/issues/comments/9'),
    thread(106, 'author', 900, 'acme/vault', 'Issue', 'Backups are slow', '/repos/acme/vault/issues/4', '/repos/acme/vault/issues/comments/10'),
    thread(107, 'subscribed', 600, 'acme/widgets', 'Commit', 'Tidy the build script', '/repos/acme/widgets/commits/abc123', 'https://elsewhere.invalid/repos/acme/widgets/comments/1')];
  bodies = { '/repos/acme/widgets/issues/comments/501': { html_url: 'https://github.example/acme/widgets/issues/12#issuecomment-501', user: { login: 'dana-example' }, body: 'Can you take a look, @me-example?' },
    '/repos/acme/widgets/pulls/7': { html_url: 'https://github.example/acme/widgets/pull/7', user: { login: 'sam-example' }, body: 'Retries the upload three times.\n' } };
  const core = await listen((req, res, body) => { assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(body); assert.equal(j.source, 'github'); got.push(j);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-github-'));
  const run = () => new Promise(ok => { got.length = 0; const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_GITHUB_API: api, CLOCKWORK_GITHUB_PACE_MS: '0' } });
    let err = '', out = ''; c.stderr.on('data', d => err += d); c.stdout.on('data', d => out += d); c.on('exit', code => { assert.ok(!(err + out).includes(TOKEN), 'the token is never printed'); ok({ code, err }); }); });
  const items = () => got.flatMap(j => j.events), listings = () => calls.filter(c => c.route === '/notifications').length;
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(got.at(-1).status, 'needs_login', 'no token yet: says so and reads nothing'); assert.deepEqual(calls, []);
    fs.writeFileSync(path.join(data, 'token'), 'ghp_revoked_not_real\n');
    r = await run(); assert.equal(got.at(-1).status, 'needs_login', 'a token GitHub rejects'); assert.deepEqual(items(), []); assert.equal(calls.length, 1); assert.ok(!fs.existsSync(path.join(data, 'state.json')));

    // First real run: a short "slow down" is waited out, then the last 24 hours arrive as history.
    fs.writeFileSync(path.join(data, 'token'), TOKEN + '\n'); calls.length = 0;
    r = await run(); assert.equal(r.err, ''); assert.equal(got.at(-1).status, 'ok'); const a = items(), by = id => a.find(e => e.threadId === String(id));
    assert.deepEqual(a.map(e => e.threadId), ['101', '102', '103', '104', '105', '106', '107'], 'oldest first, and nothing older than a day');
    assert.ok(a.every(e => e.origin === 'history' && e.direction === 'incoming' && e.kind === 'text'));
    assert.deepEqual(by(101), { sourceId: '101:' + threads[1].updated_at, threadId: '101', author: 'dana-example', authorName: 'dana-example', sourceTime: new Date(threads[1].updated_at).toISOString(),
      direction: 'incoming', isGroup: true, kind: 'text', text: '[mention] Issue: Widget crashes on empty input\n\ndana-example: Can you take a look, @me-example?', chatName: 'acme/widgets', origin: 'history',
      url: 'https://github.example/acme/widgets/issues/12#issuecomment-501' });
    assert.equal(by(102).text, '[review_requested] Pull request: Add a retry to the uploader\n\nsam-example: Retries the upload three times.'); assert.equal(by(102).url, 'https://github.example/acme/widgets/pull/7');
    assert.equal(by(103).text, '[ci_activity] Workflow run: Tests workflow run failed for main branch'); assert.equal(by(103).url, 'https://github.example/acme/widgets/actions'); assert.equal(by(103).authorName, 'GitHub');
    assert.match(by(104).text, /^\[security_alert\] Security alert: /); assert.equal(by(104).url, 'https://github.example/acme/vault/security/dependabot'); assert.equal(by(104).chatName, 'acme/vault');
    assert.equal(by(105).text, '[assign] Issue: Rotate the staging keys', 'a comment the token cannot read leaves the title'); assert.equal(by(105).url, 'https://github.example/acme/vault/issues/3');
    assert.equal(by(107).url, 'https://github.example/acme/widgets/commit/abc123');
    assert.equal(calls.filter(c => c.route.startsWith('/repos/acme/vault/')).length, 1, 'a repository that said no is not asked again in the same pass');
    assert.equal(calls.filter(c => c.route.startsWith('/repos/')).length, 3, 'one call per thread at most, and none to an address outside the API');
    assert.equal(listings(), 2, 'the listing was tried again once after the short wait');

    // Nothing new: GitHub is asked with If-Modified-Since, answers 304, and nothing is sent.
    calls.length = 0; r = await run(); assert.equal(r.err, ''); assert.deepEqual(items(), []); assert.ok(got.length >= 1, 'still reports in');
    assert.deepEqual(calls.map(c => [c.route, c.since]), [['/notifications', modified]]);

    // A thread gets a new comment and a new thread appears: two items, the updated thread under a new sourceId.
    const before = by(101).sourceId; threads[1].updated_at = iso(-2); threads[1].subject.latest_comment_url = api + '/repos/acme/widgets/issues/comments/502';
    bodies['/repos/acme/widgets/issues/comments/502'] = { html_url: 'https://github.example/acme/widgets/issues/12#issuecomment-502', user: { login: 'sam-example' }, body: 'Fixed in the next release.' };
    threads.push(thread(108, 'team_mention', -3, 'acme/widgets', 'Discussion', 'Where should the docs live?', '/repos/acme/widgets/discussions/20', null));
    modified = 'Mon, 02 Nov 2026 11:00:00 GMT'; poll = '2'; calls.length = 0;
    r = await run(); assert.equal(r.err, ''); const b = items();
    assert.deepEqual(b.map(e => e.threadId), ['101', '108']); assert.ok(b.every(e => e.origin === undefined), 'only the first run is history');
    assert.notEqual(b[0].sourceId, before); assert.equal(b[0].sourceId, '101:' + threads[1].updated_at); assert.match(b[0].text, /sam-example: Fixed in the next release\.$/);
    assert.equal(b[1].url, 'https://github.example/acme/widgets/discussions/20');

    // GitHub said "not before 2 seconds from now" (X-Poll-Interval): a run inside that time does not call GitHub at all.
    calls.length = 0; r = await run(); assert.deepEqual(calls, []); assert.deepEqual(items(), []); assert.equal(got.at(-1).status, 'ok');
    await wait(2100); r = await run(); assert.equal(listings(), 1); assert.deepEqual(items(), [], 'and nothing is sent twice');

    // A long rate limit: one call, the pass ends, and later runs stay away until GitHub's reset time.
    modified = 'Mon, 02 Nov 2026 12:00:00 GMT'; poll = '0'; await wait(2100); limit = 'long'; calls.length = 0;
    r = await run(); assert.equal(calls.length, 1); assert.equal(got.at(-1).status, 'rate_limited'); assert.match(r.err, /slow down/);
    limit = ''; r = await run(); assert.equal(calls.length, 1, 'no further call before the reset time'); assert.equal(got.at(-1).status, 'rate_limited');

    assert.ok(calls.length && fs.readFileSync(path.join(data, 'state.json'), 'utf8').includes('"since"'));
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600); assert.ok(!fs.readFileSync(path.join(data, 'state.json'), 'utf8').includes(TOKEN));
  } finally { github.close(); core.close(); github.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
  assert.ok(allCalls.length > 10 && allCalls.every(c => c.method === 'GET'), 'every request to GitHub was a GET: nothing is marked as read or changed');
});

test('an address for GitHub Enterprise must be https, and items are not lost when the core is down', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-github-')), got = []; let up = false, hits = 0;
  const core = await listen((req, res, body) => { if (!up && JSON.parse(body).events.length) { res.writeHead(500); return res.end('{}'); } got.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"received":0,"new":0}'); });
  const github = await listen((req, res) => { hits++; assert.equal(req.method, 'GET'); res.writeHead(200, { 'content-type': 'application/json', 'x-poll-interval': '0' });
    res.end(JSON.stringify([{ id: '1', reason: 'mention', updated_at: iso(60), subject: { title: 'Made-up title', type: 'Issue', url: null, latest_comment_url: null }, repository: { full_name: 'acme/widgets', html_url: 'https://github.example/acme/widgets' } }])); });
  const run = api => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_GITHUB_PACE_MS: '0', ...(api ? { CLOCKWORK_GITHUB_API: api } : {}) } });
    let err = ''; c.stderr.on('data', d => err += d); c.on('exit', () => ok(err)); });
  try {
    fs.writeFileSync(path.join(data, 'token'), TOKEN); fs.writeFileSync(path.join(data, 'api'), 'http://github.example/api/v3\n');
    assert.match(await run(), /must start with https/); assert.equal(got.at(-1).status, 'error'); assert.equal(hits, 0);
    fs.writeFileSync(path.join(data, 'api'), `http://127.0.0.1:${github.address().port}/api/v3/\n`);       // the address can also come from a file
    assert.match(await run(), /core answered 500/); assert.ok(!fs.existsSync(path.join(data, 'state.json')), 'nothing is remembered until the core has the items');
    up = true; got.length = 0; assert.equal(await run(), ''); assert.deepEqual(got.flatMap(j => j.events).map(e => e.threadId), ['1'], 'the item is sent on the next run');
  } finally { github.close(); core.close(); github.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('works out the page to open from the API address', () => {
  const n = (type, url) => ({ repository: { html_url: 'https://github.example/acme/widgets' }, subject: { type, url } });
  assert.equal(htmlUrl(n('PullRequest', 'https://api.github.example/repos/acme/widgets/pulls/7')), 'https://github.example/acme/widgets/pull/7');
  assert.equal(htmlUrl(n('Issue', 'https://api.github.example/repos/acme/widgets/issues/12')), 'https://github.example/acme/widgets/issues/12');
  assert.equal(htmlUrl(n('Release', 'https://api.github.example/repos/acme/widgets/releases/99')), 'https://github.example/acme/widgets/releases');
  assert.equal(htmlUrl(n('SomethingNew', null)), 'https://github.example/acme/widgets'); assert.equal(htmlUrl({ subject: {} }), undefined);
});
