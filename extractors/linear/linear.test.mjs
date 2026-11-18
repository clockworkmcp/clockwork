// The Linear extractor against a stand-in Linear API and a stand-in core. No real Linear, no real items.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), at = agoSeconds => new Date(Date.now() - agoSeconds * 1000).toISOString();
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });

test('reads the inbox, maps notifications, sends nothing twice, backs off, and only ever sends a query', async () => {
  const bodies = [], got = []; let limited = false;
  const issue = { id: 'i1', identifier: 'ENG-12', title: 'Login page is slow', url: 'https://linear.app/example/issue/ENG-12/login-page-is-slow', state: { name: 'In Progress' }, project: { name: 'Speed' } };
  const inbox = [   // kept newest first, as Linear answers
    { id: 'n4', type: 'projectUpdateCreated', createdAt: at(600), readAt: null, actor: { id: 'u3', name: 'Sam Example', displayName: 'sam' },
      project: { id: 'p1', name: 'Speed', url: 'https://linear.app/example/project/speed' }, projectUpdate: { body: 'On track for the made-up date.', url: 'https://linear.app/example/project/speed#update-1' } },
    { id: 'n3', type: 'issueStatusChanged', createdAt: at(1800), readAt: at(900), actor: null, botActor: { name: 'Deploy bot' }, issue, team: { name: 'Platform' } },
    { id: 'n2', type: 'issueNewComment', createdAt: at(3600), readAt: null, actor: { id: 'u2', name: 'Dana Example', displayName: 'dana' }, issue, team: { name: 'Platform' },
      comment: { body: 'Can you look at the cache numbers?', url: issue.url + '#comment-1' } },
    { id: 'n1', type: 'issueAssignedToYou', createdAt: at(7200), readAt: null, actor: { id: 'u2', name: 'Dana Example', displayName: 'dana' }, issue, team: { name: 'Platform' } },
    { id: 'n0', type: 'issueMention', createdAt: at(3 * 86400), readAt: null, actor: { id: 'u2', name: 'Dana Example', displayName: 'dana' }, issue: { ...issue, title: 'too old for the first run' }, team: { name: 'Platform' } }];
  const linear = await listen((req, res, body) => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/graphql'); bodies.push(body);
    const answer = (code, j, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== 'lin_api_test_not_real') return answer(401, { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] });
    if (!limited) { limited = true; return answer(429, { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }, { 'retry-after': '1' }); }
    const { variables: v } = JSON.parse(body), from = v.after ? Number(v.after) : 0, nodes = inbox.slice(from, from + v.first);
    answer(200, { data: { viewer: { id: 'u1' }, notifications: { nodes, pageInfo: { hasNextPage: from + v.first < inbox.length, endCursor: String(from + v.first) } } } });
  });
  const core = await listen((req, res, body) => { assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(body); assert.equal(j.source, 'linear'); got.push(j);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-linear-'));
  const run = () => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data,
      CLOCKWORK_LINEAR_API: `http://127.0.0.1:${linear.address().port}/graphql`, CLOCKWORK_LINEAR_PACE_MS: '0', CLOCKWORK_LINEAR_PAGE: '2' } });
    let err = '', out = ''; c.stderr.on('data', d => err += d); c.stdout.on('data', d => out += d); c.on('exit', code => ok({ code, err, out })); });
  const items = () => got.flatMap(j => j.events);
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(got.at(-1).status, 'needs_login', 'no key yet: says so and reads nothing'); assert.deepEqual(bodies, []);
    fs.writeFileSync(path.join(data, 'token'), 'lin_api_rejected_not_real\n'); got.length = 0;
    r = await run(); assert.equal(got.at(-1).status, 'needs_login', 'a key Linear rejects: says so'); assert.deepEqual(items(), []);
    assert.ok(!(r.err + r.out).includes('lin_api_'), 'the key is never printed'); assert.ok(!fs.existsSync(path.join(data, 'state.json')));

    fs.writeFileSync(path.join(data, 'token'), 'lin_api_test_not_real\n'); got.length = 0;
    r = await run(); assert.equal(r.err, ''); const a = items(), by = id => a.find(e => e.sourceId === id);
    assert.ok(limited, 'the stand-in said "slow down" once and the extractor waited and went on');
    assert.deepEqual(a.map(e => e.sourceId), ['n1', 'n2', 'n3', 'n4'], 'oldest first, and nothing older than a day');
    assert.ok(a.every(e => e.origin === 'history'), 'the first run is marked as history');
    assert.ok(a.every(e => e.direction === 'incoming' && e.kind === 'text' && !Number.isNaN(Date.parse(e.sourceTime))));
    assert.equal(by('n2').text, '[issue new comment] Can you look at the cache numbers?\n(team Platform, project Speed, status In Progress)');
    assert.equal(by('n2').authorName, 'dana'); assert.equal(by('n2').author, 'u2'); assert.equal(by('n2').threadId, 'ENG-12');
    assert.equal(by('n2').chatName, 'ENG-12 Login page is slow'); assert.equal(by('n2').url, issue.url + '#comment-1'); assert.equal(by('n2').sourceTime, inbox[2].createdAt);
    assert.equal(by('n1').text.split('\n')[0], '[issue assigned to you] Login page is slow'); assert.equal(by('n1').url, issue.url);
    assert.equal(by('n3').authorName, 'Deploy bot'); assert.equal(by('n3').author, 'bot:Deploy bot');
    assert.equal(by('n4').text, '[project update created] On track for the made-up date.'); assert.equal(by('n4').threadId, 'project:p1'); assert.equal(by('n4').chatName, 'Speed');
    assert.equal(got.at(-1).status, 'ok');

    // Second run: one new notification on the same issue is a new item, and nothing is sent twice.
    inbox.unshift({ id: 'n5', type: 'issueCommentMention', createdAt: at(-1), readAt: null, actor: { id: 'u3', name: 'Sam Example', displayName: 'sam' }, issue, team: { name: 'Platform' },
      comment: { body: 'second thing', url: issue.url + '#comment-2' } });
    got.length = 0; r = await run(); assert.equal(r.err, '');
    assert.deepEqual(items().map(e => e.sourceId), ['n5']); assert.equal(items()[0].origin, undefined); assert.equal(items()[0].threadId, 'ENG-12');
    got.length = 0; r = await run(); assert.deepEqual(items(), [], 'a third run with nothing new sends only heartbeats'); assert.ok(got.length >= 1);

    assert.ok(bodies.length >= 5);
    for (const b of bodies) { assert.ok(!/mutation/i.test(b), 'no request to Linear ever contains a mutation'); assert.match(JSON.parse(b).query, /^\s*query\b/); }
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600);
  } finally { linear.close(); core.close(); linear.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('the program text holds one query and no mutation', () => {
  const src = fs.readFileSync(path.join(HERE, 'main.mjs'), 'utf8'), q = src.match(/const QUERY = `([^`]*)`/)[1];
  assert.match(q, /^query\b/); assert.ok(!/mutation/i.test(q)); assert.equal(src.match(/fetch\(API/g).length, 1, 'one place talks to Linear');
});
