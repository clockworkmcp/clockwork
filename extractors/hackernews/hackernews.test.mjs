// The Hacker News extractor against a stand-in for the search API and a stand-in core. No real Hacker News, no real items.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig, matches, toText } from './main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), now = Math.floor(Date.now() / 1000), ME = 'ada_test';
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const comment = (id, author, story, parent, age, text, title = 'A made-up story') => ({ objectID: String(id), author, story_id: story, parent_id: parent, created_at_i: now - age, created_at: new Date((now - age) * 1000).toISOString(),
  comment_text: text, story_title: title, _tags: ['comment', 'author_' + author, 'story_' + story] });
const story = (id, author, age, title, extra = {}) => ({ objectID: String(id), author, story_id: id, created_at_i: now - age, created_at: new Date((now - age) * 1000).toISOString(), title, num_comments: 0, points: 1,
  _tags: ['story', 'author_' + author, 'story_' + id], ...extra });

test('brings in replies to the user and keyword matches, each once, and only ever reads', async () => {
  const reqs = [], got = []; let limited = false, coreUp = true;
  const all = [
    comment(100, ME, 10, 10, 2 * 86400, 'my older comment, still watched for replies'),
    story(20, ME, 5 * 3600, 'Show HN: A made-up tool', { url: 'https://tool.example.invalid/' }),
    comment(101, 'bo', 10, 100, 3 * 3600, 'Nice &amp; simple.<p>See <a href="https:&#x2F;&#x2F;example.invalid&#x2F;x" rel="nofollow">https:&#x2F;&#x2F;example.invalid&#x2F;x</a> for a clockwork one'),
    comment(102, 'cy', 10, 999, 2 * 3600, 'talk between other people'),
    comment(103, 'cy', 20, 20, 3600, 'does it run offline?', 'Show HN: A made-up tool'),
    comment(104, 'di', 10, 100, 3 * 86400, 'a reply too old for the first run'),
    story(30, 'di', 2 * 3600, 'Clockwork for feeds', { url: 'https://feeds.example.invalid/', story_text: 'Some <i>notes</i> on it.' }),
    comment(105, 'ed', 40, 40, 4 * 3600, 'I do feed triage every morning', 'Another story'),
    comment(106, 'ed', 40, 40, 4000, 'clokwork with a typo is not a match', 'Another story'),
    comment(107, 'fy', 40, 40, 3000, 'triage of my feed, the other way round', 'Another story'),
    comment(108, ME, 40, 105, 1800, 'so do I, with clockwork', 'Another story'),
    comment(110, 'hy', 10, 100, 5 * 3600, 'a reply at the far end of a busy day')];
  const api = await listen((req, res) => {
    const u = new URL(req.url, 'http://x'), q = Object.fromEntries(u.searchParams); reqs.push({ method: req.method, path: u.pathname, q, agent: req.headers['user-agent'] });
    const answer = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === `/api/v1/users/${ME}`) return answer(200, { username: ME, karma: 1, about: '' });
    if (u.pathname.startsWith('/api/v1/users/')) { res.writeHead(500); return res.end('<title>500 Internal Server Error</title>'); }       // what the real service answers for a name nobody has
    if (u.pathname !== '/api/v1/search_by_date') return answer(404, {});
    if (!limited) { limited = true; res.writeHead(429, { 'retry-after': '1' }); return res.end('{}'); }
    const since = Number(/^created_at_i>(\d+)/.exec(q.numericFilters || '')?.[1] ?? NaN), before = Number(/,created_at_i<(\d+)$/.exec(q.numericFilters || '')?.[1] ?? Infinity), groups = (q.tags || '').match(/\([^)]*\)|[^,()]+/g) || [];
    const loose = (q.query || '').replace(/"/g, '').slice(0, 3).toLowerCase();                                    // forgiving about spelling, like the real search
    const hits = all.filter(h => h.created_at_i > since && h.created_at_i < before && groups.every(g => g.replace(/[()]/g, '').split(',').some(t => h._tags.includes(t)))
      && (!loose || [h.title, h.comment_text, h.story_text].join(' ').toLowerCase().includes(loose))).sort((a, b) => b.created_at_i - a.created_at_i);
    const page = Number(q.page || 0), size = 2, reach = 3;                                                        // tiny pages and only three of them, like the real limit of 1000 results
    answer(200, { hits: hits.slice(page * size, page * size + size), page, nbPages: Math.min(reach, Math.ceil(hits.length / size)), hitsPerPage: size, nbHits: hits.length });
  });
  const core = await listen((req, res, body) => { const j = JSON.parse(body); if (!coreUp) { res.writeHead(500); return res.end('{}'); }
    got.push({ ...j, url: req.url, auth: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-hackernews-')), config = c => fs.writeFileSync(path.join(data, 'config.json'), typeof c === 'string' ? c : JSON.stringify(c));
  const run = () => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data,
      CLOCKWORK_HACKERNEWS_API: `http://127.0.0.1:${api.address().port}/api/v1`, CLOCKWORK_HACKERNEWS_PACE_MS: '0' } });
    let err = ''; c.stderr.on('data', d => err += d); c.on('exit', code => ok({ code, err })); });
  const items = () => got.flatMap(j => j.events), ids = () => items().map(e => e.sourceId).sort();
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(got.at(-1).status, 'needs_login', 'no config.json yet: says so and reads nothing');
    config('{ not json'); r = await run(); assert.equal(got.at(-1).status, 'needs_login', 'a config that cannot be read is the same'); assert.deepEqual(reqs, []);
    config({ username: 'nobody_here' }); limited = true; r = await run(); assert.equal(got.at(-1).status, 'needs_login', 'a name nobody has is rejected'); assert.match(r.err, /no Hacker News user "nobody_here"/);
    assert.ok(!fs.existsSync(path.join(data, 'state.json')));

    config({ username: ME, keywords: ['clockwork', '"feed triage"'] }); limited = false; got.length = 0; reqs.length = 0;
    r = await run(); assert.equal(r.err, ''); const a = items(), by = id => a.find(e => e.sourceId === String(id));
    assert.deepEqual(ids(), ['101', '103', '105', '108', '110', '20', '30'], JSON.stringify(a.map(e => e.text)));
    assert.ok(a.every(e => e.origin === 'history'), 'the first run is marked as history');
    assert.ok(got.every(j => j.source === 'hackernews' && j.url === '/ingest/events' && j.auth === 'Bearer ingest')); assert.equal(got.at(-1).status, 'ok');
    assert.deepEqual(by(101), { sourceId: '101', threadId: '10', author: 'bo', authorName: 'bo', sourceTime: new Date((now - 3 * 3600) * 1000).toISOString(), direction: 'incoming', isGroup: true, kind: 'text',
      text: 'On "A made-up story":\nNice & simple.\n\nSee https://example.invalid/x for a clockwork one', chatName: 'reply to you', origin: 'history', url: 'https://news.ycombinator.com/item?id=101' });
    assert.equal(by(103).chatName, 'reply to you', 'a comment on the user\'s own story is a reply'); assert.equal(by(103).threadId, '20');
    assert.equal(by(20).direction, 'outgoing'); assert.equal(by(20).text, 'Show HN: A made-up tool\nhttps://tool.example.invalid/'); assert.equal(by(108).direction, 'outgoing'); assert.equal(by(108).chatName, undefined);
    assert.equal(by(30).chatName, 'keyword: clockwork'); assert.equal(by(30).text, 'Clockwork for feeds\nhttps://feeds.example.invalid/\nSome notes on it.'); assert.equal(by(30).direction, 'incoming');
    assert.equal(by(105).chatName, 'keyword: "feed triage"'); assert.equal(by(105).threadId, '40');
    assert.equal(reqs.filter(q => q.path.endsWith('/search_by_date')).slice(0, 2).every(q => q.q.tags === `author_${ME}`), true, 'the rate-limited call was asked again, after the wait');

    // The core is down while a reply and a keyword match arrive: nothing is remembered as sent, so both arrive once it is back.
    all.push(comment(109, 'ed', 40, 108, -1, 'a late reply', 'Another story'), story(31, 'gi', -2, 'More clockwork news'));
    coreUp = false; got.length = 0; r = await run(); assert.match(r.err, /core answered 500/); assert.deepEqual(items(), []);
    coreUp = true; r = await run(); assert.equal(r.err, '');
    assert.deepEqual(items().map(e => [e.sourceId, e.chatName, e.origin]).sort(), [['109', 'reply to you', undefined], ['31', 'keyword: clockwork', undefined]]);
    got.length = 0; r = await run(); assert.deepEqual(items(), [], 'a pass with nothing new sends only heartbeats'); assert.ok(got.length >= 1);

    assert.ok(reqs.length > 10 && reqs.every(q => q.method === 'GET'), 'the service is only ever read with GET');
    assert.deepEqual([...new Set(reqs.map(q => q.path))], ['/api/v1/search_by_date'], 'and only searched');
    assert.ok(reqs.every(q => /^created_at_i>\d+(,created_at_i<\d+)?$/.test(q.q.numericFilters) && /read-only/.test(q.agent)));
    assert.ok(reqs.some(q => /created_at_i<\d+$/.test(q.q.numericFilters)), 'when there are more results than one question gives, it asks for the older ones');
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600);
  } finally { api.close(); core.close(); api.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('config, keyword matching and markup', () => {
  assert.equal(readConfig('{}'), null); assert.equal(readConfig('{"username":"has space"}'), null); assert.equal(readConfig('[]'), null);
  assert.deepEqual(readConfig('{"username":" ada_test ","keywords":["  two  words ","",7,"two words"]}'), { username: 'ada_test', keywords: ['two words'] });
  assert.deepEqual(readConfig('{"keywords":["solo"]}'), { username: '', keywords: ['solo'] });
  const c = t => ({ _tags: ['comment'], comment_text: t });
  assert.ok(matches('local first', c('First of all, it is LOCAL'))); assert.ok(!matches('"local first"', c('First of all, it is local'))); assert.ok(matches('"local first" sync', c('Sync for local first apps')));
  assert.ok(matches('example.invalid', { _tags: ['story'], title: 'A title', url: 'https://example.invalid/a' })); assert.ok(!matches('missing', { _tags: ['story'], title: 'A title' }));
  assert.equal(toText('<pre><code>x &lt; y</code></pre><p><i>done</i>'), 'x < y\n\ndone');
});
