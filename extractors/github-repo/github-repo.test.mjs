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

test('reads a repository directly, sends nothing twice, skips named people, needs a token only when private, and only ever reads', async () => {
  const calls = [], got = [], statuses = []; let mode = 'ok', etag = '"v1"';
  const gh = { stars: 2, forks: 0, commits: [], issues: [], comments: [], reviewComments: [], stargazers: [], forkList: [], events: [] };
  const github = await listen((req, res) => {
    const u = new URL(req.url, 'http://x'), route = u.pathname.replace('/repos/acme/widgets', '') || '/'; calls.push({ method: req.method, route, auth: req.headers.authorization, accept: req.headers.accept });
    assert.ok(req.headers['user-agent'], 'GitHub rejects calls without a User-Agent');
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (mode === 'private' && req.headers.authorization !== 'Bearer ' + TOKEN) return json(404, { message: 'Not Found' });
    const since = Date.parse(u.searchParams.get('since') || 0), first = u.searchParams.get('page') === '1', changed = l => first ? l.filter(x => Date.parse(x.updated_at || x.created_at) >= since) : [];
    if (route === '/') return json(200, { full_name: 'acme/widgets', stargazers_count: gh.stars, forks_count: gh.forks });
    if (route === '/issues') { assert.equal(u.searchParams.get('state'), 'all'); return json(200, changed(gh.issues)); }
    if (route === '/issues/comments') return json(200, changed(gh.comments));
    if (route === '/pulls/comments') return json(200, changed(gh.reviewComments));
    if (route === '/commits') return json(200, first ? gh.commits.filter(c => Date.parse(c.commit.committer.date) >= since) : []);
    if (route === '/stargazers') { assert.equal(req.headers.accept, 'application/vnd.github.star+json', 'only this form says when each star was given'); return json(200, gh.stargazers); }
    if (route === '/forks') return json(200, gh.forkList);
    if (route === '/events') { const head = { etag, 'x-poll-interval': '0' }; if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); return res.end(); } return json(200, first ? gh.events : [], head); }
    return json(404, { message: 'Not Found' });
  });
  const api = `http://127.0.0.1:${github.address().port}`, W = 'https://github.example/acme/widgets';
  const core = await listen((req, res, body) => {
    assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest-test'); const b = JSON.parse(body);
    assert.equal(b.source, 'github'); assert.equal(b.account, 'repos'); statuses.push(b.status); got.push(...b.events);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: b.events.length, new: b.events.length }));
  });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ghrepo-'));
  const run = (env = {}) => new Promise(done => { const out = []; const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { env: { PATH: process.env.PATH,
    CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest-test', CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_GITHUB_API: api, CLOCKWORK_GITHUB_WEB: 'https://github.example',
    CLOCKWORK_GITHUB_PACE_MS: '0', ...env } }); c.stdout.on('data', d => out.push(d)); c.stderr.on('data', d => out.push(d)); c.on('exit', () => done(Buffer.concat(out).toString())); });
  const issue = (n, agoS, login, title, extra = {}) => ({ id: 9000 + n, number: n, title, body: 'Details of ' + title, state: 'open', user: { login }, created_at: iso(agoS), updated_at: iso(agoS), html_url: `${W}/issues/${n}`, ...extra });
  const text = id => got.find(i => i.sourceId === id)?.text;
  try {
    // Nothing named yet: it says so and asks GitHub nothing.
    await run(); assert.equal(statuses.at(-1), 'needs_login'); assert.equal(calls.length, 0);

    fs.writeFileSync(path.join(data, 'repos'), 'acme/widgets\n'); fs.writeFileSync(path.join(data, 'skip'), 'Owner-Example\n');
    gh.issues = [issue(1, 3 * 86400, 'dana-example', 'Too old for the first run'), issue(12, 1200, 'dana-example', 'Crash on empty input'),
      issue(9, 900, 'sam-example', 'Speed up the build', { pull_request: { merged_at: null }, html_url: `${W}/pull/9` }), issue(13, 800, 'owner-example', 'My own note')];
    gh.comments = [{ id: 501, issue_url: `${api}/repos/acme/widgets/issues/12`, html_url: `${W}/issues/12#issuecomment-501`, user: { login: 'sam-example' }, body: 'Same here', created_at: iso(700), updated_at: iso(700) }];
    gh.reviewComments = [{ id: 601, pull_request_url: `${api}/repos/acme/widgets/pulls/9`, html_url: `${W}/pull/9#discussion_r601`, user: { login: 'dana-example' }, body: 'Why this flag?', path: 'build.sh', created_at: iso(600), updated_at: iso(600) }];
    gh.stargazers = [{ starred_at: iso(5 * 86400), user: { login: 'early-example', html_url: 'https://github.example/early-example' } }, { starred_at: iso(300), user: { login: 'dana-example', html_url: 'https://github.example/dana-example' } }];
    gh.commits = [{ sha: 'abc1234', html_url: `${W}/commit/abc1234`, author: { login: 'sam-example' }, commit: { message: 'Fix the uploader\n\nLong text', committer: { date: iso(500) } } },
      { sha: 'def5678', author: { login: 'owner-example' }, commit: { message: 'My own change', committer: { date: iso(450) } } }];
    gh.events = [ev(205, 'ReleaseEvent', 400, 'sam-example', { action: 'published', release: { tag_name: 'v1.0' } }), ev(204, 'PushEvent', 450, 'sam-example', { ref: 'refs/heads/main' }),
      ev(203, 'IssuesEvent', 1200, 'dana-example', { action: 'opened', issue: { number: 12, title: 'Crash on empty input' } }), ev(9, 'PublicEvent', 5 * 86400, 'owner-example', {})];
    await run();
    assert.deepEqual(got.map(i => i.sourceId), ['issue:9012:opened', 'pull request:9009:opened', 'comment:501', 'review-comment:601', 'commit:abc1234', 'ev:205', 'star:dana-example:' + gh.stargazers[1].starred_at],
      'oldest first; the old issue, the old star, the skipped person and the activity entry for an issue already read directly are left out');
    assert.ok(got.every(i => i.origin === 'history'), 'the first run is marked as history');
    assert.equal(text('issue:9012:opened'), '[issue opened] #12 Crash on empty input\n\ndana-example: Details of Crash on empty input');
    assert.equal(text('comment:501'), '[comment] on issue #12 Crash on empty input\n\nsam-example: Same here'); assert.equal(got[2].threadId, 'acme/widgets#12');
    assert.equal(text('review-comment:601'), '[review comment] on pull request #9 Speed up the build (build.sh)\n\ndana-example: Why this flag?'); assert.equal(got[3].url, `${W}/pull/9#discussion_r601`);
    assert.equal(text('commit:abc1234'), '[commit] Fix the uploader'); assert.equal(text('ev:205'), '[release published] v1.0'); assert.equal(got[6].text, '[star] dana-example starred acme/widgets (2 in all)');
    assert.equal(statuses.at(-1), 'ok'); assert.equal(calls[0].auth, undefined, 'no token, no authorization header');

    // Nothing changed: the stars are not asked for again and nothing new is sent (what overlaps carries the same ids).
    const before = new Set(got.map(i => i.sourceId)); calls.length = 0; await run();
    assert.ok(got.every(i => before.has(i.sourceId))); assert.ok(!calls.some(c => c.route === '/stargazers' || c.route === '/forks'));

    // A pull request is merged, an issue is closed and opened again, someone new stars and forks: each arrives once, and no longer as history.
    got.length = 0; etag = '"v2"';
    Object.assign(gh.issues[2], { state: 'closed', closed_at: iso(20), updated_at: iso(20), pull_request: { merged_at: iso(20) } });
    Object.assign(gh.issues[1], { state: 'closed', closed_at: iso(30), updated_at: iso(30) });
    gh.stars = 3; gh.stargazers.push({ starred_at: iso(10), user: { login: 'new-example' } }); gh.forks = 1; gh.forkList = [{ id: 77, full_name: 'new-example/widgets', html_url: 'https://github.example/new-example/widgets', owner: { login: 'new-example' }, created_at: iso(15) }];
    await run();
    assert.equal(text(`issue:9012:closed:${gh.issues[1].closed_at}`), '[issue closed] #12 Crash on empty input'); assert.equal(text(`pull request:9009:closed:${gh.issues[2].closed_at}`), '[pull request merged] #9 Speed up the build');
    assert.equal(text('fork:77'), '[fork] new-example forked acme/widgets to new-example/widgets'); assert.equal(text('star:new-example:' + gh.stargazers[2].starred_at), '[star] new-example starred acme/widgets (3 in all)');
    assert.ok(got.filter(i => !before.has(i.sourceId)).every(i => i.origin === undefined));
    got.length = 0; Object.assign(gh.issues[1], { state: 'open', closed_at: null, updated_at: iso(1) }); await run();
    assert.ok(got.some(i => i.text === '[issue reopened] #12 Crash on empty input'));

    // A private repository without a token: it reports that a login is needed. With the token it reads again.
    mode = 'private'; got.length = 0; fs.writeFileSync(path.join(data, 'state.json'), '{}');
    const told = await run(); assert.equal(statuses.at(-1), 'needs_login'); assert.match(told, /private repository needs a token/); assert.equal(got.length, 0);
    fs.writeFileSync(path.join(data, 'state.json'), '{}'); calls.length = 0;
    await run({ CLOCKWORK_SECRET_TOKEN: TOKEN }); assert.equal(statuses.at(-1), 'ok'); assert.ok(got.length >= 4); assert.equal(calls[0].auth, 'Bearer ' + TOKEN);
    const kept = fs.readFileSync(path.join(data, 'state.json'), 'utf8'); assert.ok(!kept.includes('Crash') && !kept.includes(TOKEN), 'neither item text nor the token is kept in the state file');
  } finally { github.close(); core.close(); fs.rmSync(data, { recursive: true, force: true }); }
  // Read-only by construction.
  assert.ok(calls.every(c => c.method === 'GET'));
});
