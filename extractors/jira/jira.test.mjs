// The Jira extractor against a stand-in Jira site and a stand-in core. No real Jira, no real items.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adfText } from './main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), at = agoSeconds => new Date(Date.now() - agoSeconds * 1000).toISOString().replace('Z', '+0000');   // Jira writes times like this
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const doc = (...content) => ({ type: 'doc', version: 1, content }), p = (...content) => ({ type: 'paragraph', content }), t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const ME = { accountId: 'acc-me', displayName: 'Me' }, DANA = { accountId: 'acc-dana', displayName: 'Dana Example' }, SAM = { accountId: 'acc-sam', displayName: 'Sam Example' };

test('finds updated issues, tells comments from changes, skips my own, sends nothing twice, backs off, and only ever uses GET', async () => {
  const calls = [], got = [], jqls = []; let limited = false;
  const issue = (key, summary, status, updated, created, histories = []) => ({ id: key, key, fields: { summary, status: { name: status }, updated, created, creator: DANA, reporter: DANA }, changelog: { histories } });
  const issues = [
    issue('ABC-2', 'Export times out', 'In Progress', at(7200), at(9 * 86400), [{ author: SAM, created: at(7200), items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }, { field: 'assignee', fromString: null, toString: 'Me' }] },
      { author: DANA, created: at(8 * 86400), items: [{ field: 'priority', fromString: 'Low', toString: 'High' }] }]),
    issue('ABC-1', 'Login page is slow', 'To Do', at(3600), at(5 * 86400), [{ author: SAM, created: at(4 * 86400), items: [{ field: 'labels', fromString: '', toString: 'speed' }] }]),
    issue('ABC-3', 'Tidy the docs', 'Done', at(1800), at(6 * 86400), [{ author: ME, created: at(1800), items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }] }]),
    issue('ABC-5', 'Brand new request', 'To Do', at(600), at(600)),
    issue('ABC-4', 'too old for the first run', 'To Do', at(3 * 86400), at(9 * 86400))];
  const comments = { 'ABC-1': [{ author: DANA, created: at(3600), updated: at(3600), body: doc(p(t('Can you check this today '), { type: 'mention', attrs: { id: 'acc-me', text: '@Me' } }, t('? See '), t('the notes', [{ type: 'link', attrs: { href: 'https://example.invalid/n' } }])),
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('first'))] }, { type: 'listItem', content: [p(t('second'))] }] }) }] };
  const jira = await listen((req, res) => {
    const u = new URL(req.url, 'http://x'), q = u.searchParams; calls.push(`${req.method} ${u.pathname}`);
    const answer = (code, j, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== 'Basic ' + Buffer.from('me@example.invalid:token-not-real').toString('base64')) return answer(401, { message: 'Client must be authenticated to access this resource.' });
    if (u.pathname === '/rest/api/3/myself') return answer(200, ME);
    if (u.pathname === '/rest/api/3/search/jql') {
      if (!limited) { limited = true; return answer(429, {}, { 'retry-after': '1' }); }
      jqls.push(q.get('jql')); const minutes = Number(q.get('jql').match(/updated >= -(\d+)m ORDER BY updated ASC$/)[1]);
      assert.equal(q.get('expand'), 'changelog'); assert.match(q.get('fields'), /summary/);
      const all = issues.filter(i => Date.parse(i.fields.updated) >= Date.now() - minutes * 60_000).sort((a, b) => Date.parse(a.fields.updated) - Date.parse(b.fields.updated));
      const from = Number(q.get('nextPageToken') || 0), n = Number(q.get('maxResults')), last = from + n >= all.length;
      return answer(200, { issues: all.slice(from, from + n), isLast: last, ...(last ? {} : { nextPageToken: String(from + n) }) });
    }
    const m = u.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/);
    if (m) { assert.equal(q.get('orderBy'), '-created'); const list = [...(comments[m[1]] || [])].reverse().slice(0, Number(q.get('maxResults'))); return answer(200, { comments: list, total: (comments[m[1]] || []).length }); }
    answer(404, {});
  });
  const core = await listen((req, res, body) => { assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(body); assert.equal(j.source, 'jira'); got.push(j);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-jira-'));
  const run = () => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data,
      CLOCKWORK_JIRA_API: `http://127.0.0.1:${jira.address().port}`, CLOCKWORK_JIRA_PACE_MS: '0', CLOCKWORK_JIRA_PAGE: '2' } });
    let err = '', out = ''; c.stderr.on('data', d => err += d); c.stdout.on('data', d => out += d); c.on('exit', code => ok({ code, err, out })); });
  const items = () => got.flatMap(j => j.events), login = o => fs.writeFileSync(path.join(data, 'login.json'), JSON.stringify({ site: 'https://example.atlassian.net', email: 'me@example.invalid', ...o }));
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(got.at(-1).status, 'needs_login', 'no login yet: says so and reads nothing'); assert.deepEqual(calls, []);
    login({ apiToken: 'rejected-not-real' }); got.length = 0;
    r = await run(); assert.equal(got.at(-1).status, 'needs_login', 'a login Jira rejects: says so'); assert.deepEqual(items(), []); assert.deepEqual(calls, ['GET /rest/api/3/myself']);
    assert.ok(!(r.err + r.out).includes('rejected-not-real'), 'the token is never printed'); assert.ok(!fs.existsSync(path.join(data, 'state.json')));
    fs.writeFileSync(path.join(data, 'login.json'), JSON.stringify({ site: 'http://example.atlassian.net', email: 'me@example.invalid', apiToken: 'token-not-real' })); got.length = 0; calls.length = 0;
    r = await run(); assert.equal(got.at(-1).status, 'needs_login', 'a site that is not https is refused'); assert.deepEqual(calls, []);

    login({ apiToken: 'token-not-real' }); got.length = 0;
    r = await run(); assert.equal(r.err, ''); const a = items(), by = k => a.find(e => e.threadId === 'example.atlassian.net:' + k);
    assert.ok(limited, 'the stand-in said "slow down" once and the extractor waited and went on');
    assert.match(jqls[0], /^\(assignee = currentUser\(\) OR reporter = currentUser\(\) OR watcher = currentUser\(\)\) AND updated >= -1440m ORDER BY updated ASC$/);
    assert.deepEqual(a.map(e => e.chatName), ['ABC-2 Export times out', 'ABC-1 Login page is slow', 'ABC-5 Brand new request'], 'oldest first; my own update and the old issue are left out');
    assert.ok(a.every(e => e.origin === 'history'), 'the first run is marked as history');
    assert.ok(a.every(e => e.direction === 'incoming' && e.kind === 'text'));
    assert.equal(by('ABC-1').text, 'Comment on ABC-1 (To Do): Can you check this today @Me? See the notes (https://example.invalid/n)\n- first\n- second');
    assert.equal(by('ABC-1').authorName, 'Dana Example'); assert.equal(by('ABC-1').author, 'acc-dana'); assert.equal(by('ABC-1').url, 'https://example.atlassian.net/browse/ABC-1');
    assert.equal(by('ABC-1').sourceId, 'example.atlassian.net:ABC-1:' + issues[1].fields.updated); assert.equal(by('ABC-1').sourceTime, new Date(issues[1].fields.updated).toISOString());
    assert.equal(by('ABC-2').text, 'ABC-2 changed (In Progress): status: To Do -> In Progress; assignee: none -> Me'); assert.equal(by('ABC-2').authorName, 'Sam Example');
    assert.equal(by('ABC-5').text, 'ABC-5 created (To Do): Brand new request'); assert.equal(by('ABC-5').authorName, 'Dana Example');
    assert.equal(got.at(-1).events.length, 3, 'items go to the core in one batch, after reading');

    // Second run: a new comment on ABC-2 is a new item for that issue; nothing else is sent again.
    const before = by('ABC-2').sourceId;
    comments['ABC-2'] = [{ author: DANA, created: at(-1), updated: at(-1), body: doc(p(t('second thing'))) }]; issues[0].fields.updated = at(-1);
    got.length = 0; jqls.length = 0; r = await run(); assert.equal(r.err, '');
    assert.deepEqual(items().map(e => e.text), ['Comment on ABC-2 (In Progress): second thing']); assert.equal(items()[0].origin, undefined);
    assert.notEqual(items()[0].sourceId, before); assert.equal(items()[0].threadId, 'example.atlassian.net:ABC-2');
    assert.match(jqls[0], /updated >= -[5-7]m ORDER BY/, 'later runs look back only a few minutes');
    got.length = 0; r = await run(); assert.deepEqual(items(), [], 'a third run with nothing new sends only heartbeats'); assert.ok(got.length >= 1);

    // An override for the search is used in place of the default, without its own ordering.
    login({ apiToken: 'token-not-real', jql: 'project = ABC order by created' }); jqls.length = 0; await run();
    assert.match(jqls[0], /^\(project = ABC\) AND updated >= -\d+m ORDER BY updated ASC$/);

    assert.ok(calls.length > 8); assert.ok(calls.every(c => c.startsWith('GET ')), 'Jira is only ever asked with GET');
    assert.deepEqual([...new Set(calls.map(c => c.replace(/[A-Z]+-\d+/, 'KEY')))].sort(), ['GET /rest/api/3/issue/KEY/comment', 'GET /rest/api/3/myself', 'GET /rest/api/3/search/jql']);
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600);
  } finally { jira.close(); core.close(); jira.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('Atlassian Document Format becomes plain text', () => {
  assert.equal(adfText(doc({ type: 'heading', attrs: { level: 2 }, content: [t('Plan')] }, p(t('one'), { type: 'hardBreak' }, t('two '), { type: 'emoji', attrs: { shortName: ':tada:' } }),
    { type: 'codeBlock', content: [t('x = 1')] }, { type: 'blockquote', content: [p(t('quoted'))] }, { type: 'rule' },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('a'))] }, { type: 'tableCell', content: [p(t('b'))] }] }] },
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1' } }] }, p({ type: 'inlineCard', attrs: { url: 'https://example.invalid/card' } }, t(' '), { type: 'status', attrs: { text: 'BLOCKED' } }),
    { type: 'somethingNew', content: [p(t('still read'))] })),
  'Plan\none\ntwo :tada:\nx = 1\n> quoted\n---\na | b\n[attachment]\nhttps://example.invalid/card [BLOCKED]\nstill read');
  assert.equal(adfText(null), ''); assert.equal(adfText({ type: 'doc', content: [] }), '');
});

test('the program text only ever asks Jira with GET', () => {
  const src = fs.readFileSync(path.join(HERE, 'main.mjs'), 'utf8'), toJira = src.match(/fetch\(`\$\{login\.api\}[^\n]*/g);
  assert.equal(toJira.length, 1, 'one place talks to Jira'); assert.match(toJira[0], /method: 'GET'/);
});
