// The GitHub repository extractor against a stand-in GitHub API and a stand-in core. No real GitHub, no real repository.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toItem, repoList, webBase } from './main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), TOKEN = 'github_pat_test_not_real', iso = agoS => new Date(Math.floor(Date.now() / 1000 - agoS) * 1000).toISOString().replace('.000Z', 'Z');
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const ev = (id, type, agoS, login, payload) => ({ id: String(id), type, actor: { login }, repo: { name: 'acme/widgets' }, payload, created_at: iso(agoS) });

test('names of repositories are read from addresses, lists and notes', () => {
  assert.deepEqual(repoList('acme/widgets, https://github.com/acme/vault.git\n# a note\nacme/widgets not-a-repo'), ['acme/widgets', 'acme/vault']);
  assert.equal(webBase('https://api.github.com'), 'https://github.com');
  assert.equal(webBase('https://github.example.com/api/v3'), 'https://github.example.com');
});

test('each kind of activity becomes a readable item in the right thread', () => {
  const web = 'https://github.com', item = (type, payload) => toItem(ev(1, type, 60, 'dana-example', payload), web);
  const star = item('WatchEvent', { action: 'started' });
  assert.equal(star.text, '[star] dana-example starred acme/widgets'); assert.equal(star.url, 'https://github.com/dana-example'); assert.equal(star.threadId, 'acme/widgets:stars');
  const issue = item('IssuesEvent', { action: 'opened', issue: { number: 12, title: 'Crash on empty input', body: 'It falls over.', html_url: 'https://github.com/acme/widgets/issues/12' } });
  assert.equal(issue.text, '[issue opened] #12 Crash on empty input\n\ndana-example: It falls over.'); assert.equal(issue.threadId, 'acme/widgets#12');
  const closed = item('IssuesEvent', { action: 'closed', issue: { number: 12, title: 'Crash on empty input', body: 'It falls over.' } });
  assert.equal(closed.text, '[issue closed] #12 Crash on empty input'); assert.equal(closed.url, 'https://github.com/acme/widgets/issues/12');
  const prComment = item('IssueCommentEvent', { action: 'created', issue: { number: 7, title: 'Add a retry', pull_request: {} }, comment: { body: 'Looks good', html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' } });
  assert.equal(prComment.text, '[comment] on pull request #7 Add a retry\n\ndana-example: Looks good'); assert.equal(prComment.threadId, 'acme/widgets#7');
  assert.equal(item('PullRequestEvent', { action: 'closed', number: 7, pull_request: { number: 7, title: 'Add a retry', merged: true } }).text, '[pull request merged] #7 Add a retry');
  assert.equal(item('PullRequestEvent', { action: 'opened', number: 8, pull_request: { number: 8 } }).url, 'https://github.com/acme/widgets/pull/8');
  assert.equal(item('PullRequestReviewEvent', { action: 'created', pull_request: { number: 7, title: 'Add a retry' }, review: { state: 'changes_requested', body: 'One thing' } }).text, '[review changes requested] on pull request #7 Add a retry\n\ndana-example: One thing');
  const push = item('PushEvent', { ref: 'refs/heads/main', before: 'aaa', head: 'bbb', size: 2, commits: [{ message: 'Fix the uploader\n\nlong text' }, { message: 'Tidy' }] });
  assert.equal(push.text, '[push] dana-example pushed 2 commit(s) to main\n\n- Fix the uploader\n- Tidy'); assert.equal(push.url, 'https://github.com/acme/widgets/compare/aaa...bbb');
  assert.equal(item('ForkEvent', { forkee: { full_name: 'dana-example/widgets', html_url: 'https://github.com/dana-example/widgets' } }).text, '[fork] dana-example forked acme/widgets to dana-example/widgets');
  assert.equal(item('ReleaseEvent', { action: 'published', release: { tag_name: 'v1.0', body: 'First' } }).text, '[release published] v1.0\n\ndana-example: First');
  assert.equal(item('SomethingNewEvent', {}).text, '[SomethingNew] dana-example');
  for (const it of [star, issue, push]) { assert.equal(it.direction, 'incoming'); assert.equal(it.chatName, 'acme/widgets'); assert.match(it.sourceId, /^ev:\d+$/); }
});

test('reads a repository, sends nothing twice, fills in a missing title, skips named people, and only ever reads', async () => {
  const calls = [], got = [], statuses = []; let events, etag = '"v1"', mode = 'ok';
  const github = await listen((req, res) => {
    const u = new URL(req.url, 'http://x'); calls.push({ method: req.method, route: u.pathname, auth: req.headers.authorization, match: req.headers['if-none-match'] });
    assert.ok(req.headers['user-agent'], 'GitHub rejects calls without a User-Agent');
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (mode === 'private' && req.headers.authorization !== 'Bearer ' + TOKEN) return json(404, { message: 'Not Found' });
    if (u.pathname === '/repos/acme/widgets/events') {
      const head = { etag, 'x-poll-interval': '0' };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); return res.end(); }
      return json(200, u.searchParams.get('page') === '1' ? events : [], head);
    }
    if (u.pathname === '/repos/acme/widgets/pulls/9') return json(200, { number: 9, title: 'Speed up the build', html_url: 'https://github.example/acme/widgets/pull/9', body: 'Twice as fast.' });
    return json(404, { message: 'Not Found' });
  });
  const api = `http://127.0.0.1:${github.address().port}`;
  const core = await listen((req, res, body) => {
    assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest-test'); const b = JSON.parse(body);
    assert.equal(b.source, 'github'); assert.equal(b.account, 'repos'); statuses.push(b.status); got.push(...b.events);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: b.events.length, new: b.events.length }));
  });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ghrepo-'));
  const run = (env = {}) => new Promise(done => { const out = []; const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { env: { PATH: process.env.PATH,
    CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest-test', CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_GITHUB_API: api, CLOCKWORK_GITHUB_WEB: 'https://github.example',
    CLOCKWORK_GITHUB_PACE_MS: '0', ...env } }); c.stdout.on('data', d => out.push(d)); c.stderr.on('data', d => out.push(d)); c.on('exit', () => done(Buffer.concat(out).toString())); });
  try {
    // Nothing named yet: it says so and asks GitHub nothing.
    await run(); assert.equal(statuses.at(-1), 'needs_login'); assert.equal(calls.length, 0);

    fs.writeFileSync(path.join(data, 'repos'), 'acme/widgets\n'); fs.writeFileSync(path.join(data, 'skip'), 'Owner-Example\n');
    events = [   // roughly newest first; like the real list, not strictly in order and with ids that do not only grow
      ev(9, 'PublicEvent', 5 * 86400, 'owner-example', {}),
      ev(105, 'WatchEvent', 300, 'dana-example', { action: 'started' }),
      ev(104, 'PushEvent', 600, 'owner-example', { ref: 'refs/heads/main', size: 1 }),
      ev(103, 'PullRequestEvent', 900, 'sam-example', { action: 'opened', number: 9, pull_request: { number: 9, url: `${api}/repos/acme/widgets/pulls/9` } }),
      ev(102, 'IssuesEvent', 1200, 'dana-example', { action: 'opened', issue: { number: 12, title: 'Crash on empty input', body: 'It falls over.' } }),
      ev(101, 'IssuesEvent', 3 * 86400, 'dana-example', { action: 'opened', issue: { number: 1, title: 'Too old for the first run' } })];
    await run();
    assert.deepEqual(got.map(i => i.sourceId), ['ev:102', 'ev:103', 'ev:105'], 'oldest first; the old entry and the skipped person are left out');
    assert.ok(got.every(i => i.origin === 'history'), 'the first run is marked as history');
    assert.equal(got[1].text, '[pull request opened] #9 Speed up the build\n\nsam-example: Twice as fast.'); assert.equal(got[1].url, 'https://github.example/acme/widgets/pull/9');
    assert.equal(statuses.at(-1), 'ok'); assert.equal(calls[0].auth, undefined, 'no token, no authorization header');

    // Nothing changed: GitHub answers 304 and nothing is sent.
    got.length = 0; calls.length = 0; await run();
    assert.equal(got.length, 0); assert.equal(calls.length, 1); assert.equal(calls[0].match, '"v1"');

    // Something new: only that is sent, and it is no longer history.
    events.unshift(ev(106, 'IssueCommentEvent', 30, 'sam-example', { action: 'created', issue: { number: 12, title: 'Crash on empty input' }, comment: { body: 'Same here' } })); etag = '"v2"';
    events.push(ev(7, 'WatchEvent', 4 * 86400, 'late-example', { action: 'started' }));   // an old entry GitHub only lists now: from before the window, never sent
    await run();
    assert.deepEqual(got.map(i => i.sourceId), ['ev:106']); assert.equal(got[0].origin, undefined); assert.equal(got[0].threadId, 'acme/widgets#12');

    // A private repository without a token: it reports that a login is needed. With the token it reads again.
    mode = 'private'; etag = '"v3"'; got.length = 0; fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')), repos: {} }));
    const said = await run(); assert.equal(statuses.at(-1), 'needs_login'); assert.match(said, /private repository needs a token/); assert.equal(got.length, 0);
    fs.writeFileSync(path.join(data, 'state.json'), '{}'); calls.length = 0;
    await run({ CLOCKWORK_SECRET_TOKEN: TOKEN }); assert.equal(statuses.at(-1), 'ok'); assert.ok(got.length >= 4); assert.equal(calls[0].auth, 'Bearer ' + TOKEN);
    assert.ok(!JSON.stringify(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).includes('Crash'), 'no item text is kept in the state file');
  } finally { github.close(); core.close(); fs.rmSync(data, { recursive: true, force: true }); }
  // Read-only by construction.
  assert.ok(calls.every(c => c.method === 'GET'));
});
