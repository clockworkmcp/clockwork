// The RSS extractor against stand-in feeds and a stand-in core, all on this machine. No real feeds, no real items.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFeeds, parseXml, parseFeed, toText } from './main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ago = s => new Date(Date.now() - s * 1000);
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const SECRET = 'private-key-not-real';

const rssItems = [
  `<item><title><![CDATA[Version 2 & what's new]]></title><link>https://blog.example.invalid/v2</link><guid isPermaLink="false">post-2</guid><pubDate>${ago(7200).toUTCString()}</pubDate>
     <dc:creator>Dana Example</dc:creator><description>short summary</description>
     <content:encoded><![CDATA[<p>It is <b>out</b> &amp; ready.</p><script>ignored()</script><ul><li>faster</li><li>smaller &#8212; by half</li></ul>]]></content:encoded></item>`,
  `<item><title>No guid here</title><link>/posts/no-guid</link><author>jo@example.invalid (Jo Example)</author><pubDate>${ago(10800).toUTCString()}</pubDate>
     <description>&lt;p&gt;Escaped &lt;i&gt;markup&lt;/i&gt; &amp;amp; entities&lt;br/&gt;second line&lt;/p&gt;</description></item>`,
  `<item><title>Neither guid nor link</title><pubDate>${ago(3600).toUTCString()}</pubDate></item>`,
  `<item><title>Too old for the first run</title><guid>https://blog.example.invalid/old</guid><pubDate>${ago(3 * 86400).toUTCString()}</pubDate></item>`,
  `<item><guid>episode-9</guid><pubDate>${ago(1800).toUTCString()}</pubDate><enclosure url="https://blog.example.invalid/9.mp3" type="audio/mpeg" length="1"/></item>`,
];
const rss = () => `<?xml version="1.0" encoding="UTF-8"?><!-- a comment --><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>Example &amp; Co blog</title><link>https://blog.example.invalid/</link><atom:link href="https://blog.example.invalid/feed" rel="self"/>${rssItems.join('\n')}</channel></rss>`;
const atom = () => `<?xml version='1.0'?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><title>Example status</title><author><name>Ops team</name></author>
  <entry><id>tag:status.example.invalid,2026:1</id><title type="html">Database &lt;em&gt;slow&lt;/em&gt;</title><link rel="self" href="https://status.example.invalid/1.atom"/>
    <link rel="alternate" type="text/html" href="https://status.example.invalid/incidents/1"/><published>${ago(900).toISOString()}</published><updated>${ago(600).toISOString()}</updated>
    <content type="html">&lt;p&gt;We are looking into it.&lt;/p&gt;</content><author><name>Sam Example</name></author></entry>
  <entry><id>tag:status.example.invalid,2026:2</id><title>Written as xhtml</title><link href="/incidents/2"/><updated>${ago(1200).toISOString()}</updated>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>First part.</p><p>Second <a href="https://example.invalid/x">part</a>.</p></div></content></entry>
  <entry><id>yt:video:not-real</id><title>A made-up video</title><link rel="alternate" href="https://video.example.invalid/watch?v=not-real"/><published>${ago(2400).toISOString()}</published>
    <media:group><media:title>A made-up video</media:title><media:description>What the video is about.</media:description></media:group></entry></feed>`;
const json = () => JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Example notes', authors: [{ name: 'Robin Example' }], items: [
  { id: 'n1', url: 'https://notes.example.invalid/1', title: 'First note', content_html: '<p>Hello <b>there</b></p>', date_published: ago(4000).toISOString() },
  { id: 2, content_text: 'A note without a title', date_published: ago(5000).toISOString() }] });
const limited = () => `<rss version="2.0"><channel><title>Busy feed</title><item><title>Worth the wait</title><guid>busy-1</guid><pubDate>${ago(60).toUTCString()}</pubDate></item></channel></rss>`;

test('reads RSS, Atom and JSON Feed, sends each entry once, asks politely, and only ever uses GET', async () => {
  const reqs = [], got = []; let coreUp = true;
  const feeds = await listen((req, res) => {
    const p = req.url.split('?')[0], n = reqs.filter(r => r.path === p).length; reqs.push({ method: req.method, path: p, etag: req.headers['if-none-match'], since: req.headers['if-modified-since'], agent: req.headers['user-agent'] });
    if (p === '/broken') { res.writeHead(500); return res.end('no'); }
    if (p === '/limited.xml' && n === 0) { res.writeHead(429, { 'retry-after': '2' }); return res.end(''); }
    const doc = { '/blog.xml': rss, '/atom': atom, '/feed.json': json, '/limited.xml': limited }[p]; if (!doc) { res.writeHead(404); return res.end(''); }
    const body = doc(), etag = `"v${rssItems.length}"`;
    if (p === '/blog.xml' && req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, p === '/blog.xml' ? { 'content-type': 'application/rss+xml; charset=utf-8', etag, 'last-modified': 'Mon, 02 Nov 2026 10:00:00 GMT' } : { 'content-type': p.endsWith('json') ? 'application/feed+json' : 'text/xml' }); res.end(body);
  });
  const core = await listen((req, res, body) => { const j = JSON.parse(body); if (!coreUp) { res.writeHead(500); return res.end('{}'); }
    got.push({ ...j, url: req.url, auth: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-rss-')), base = `http://127.0.0.1:${feeds.address().port}`;
  const run = () => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data, CLOCKWORK_RSS_PACE_MS: '0', CLOCKWORK_RSS_POLL_MINUTES: '0' } });
    let err = '', out = ''; c.stderr.on('data', d => err += d); c.stdout.on('data', d => out += d); c.on('exit', code => ok({ code, err, out })); });
  const items = () => got.flatMap(j => j.events), asked = p => reqs.filter(r => r.path === p).length, logs = [];
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(got.at(-1).status, 'needs_login', 'no feeds.txt yet: says so and fetches nothing');
    fs.writeFileSync(path.join(data, 'feeds.txt'), '# only a note so far\n\n'); r = await run(); assert.equal(got.at(-1).status, 'needs_login', 'a list with no feeds is the same'); assert.deepEqual(reqs, []);

    fs.writeFileSync(path.join(data, 'feeds.txt'), `# my feeds\n\n${base}/blog.xml\nStatus page = ${base}/atom?key=${SECRET}\n${base}/feed.json\n  ${base}/limited.xml  \n${base}/broken\nthis is not an address\n`);
    got.length = 0; r = await run(); logs.push(r); assert.equal(r.code, 0, r.err);
    const a = items(), by = t => a.find(e => e.text.includes(t));
    assert.equal(a.length, 9, JSON.stringify(a.map(e => e.text)));
    assert.ok(a.every(e => e.origin === 'history'), 'the first read of a feed is marked as history'); assert.ok(!by('Too old'));
    assert.ok(got.every(j => j.source === 'rss' && j.url === '/ingest/events' && j.auth === 'Bearer ingest'));
    assert.equal(by('Version 2').text, 'Version 2 & what\'s new\n\nIt is out & ready.\n\n- faster\n- smaller — by half');
    assert.equal(by('Version 2').authorName, 'Dana Example'); assert.equal(by('Version 2').chatName, 'Example & Co blog'); assert.equal(by('Version 2').url, 'https://blog.example.invalid/v2');
    assert.match(by('Version 2').sourceId, /^[0-9a-f]{12}:post-2$/); assert.equal(by('Version 2').threadId, by('No guid').threadId); assert.equal(by('Version 2').direction, 'incoming');
    assert.equal(by('Version 2').sourceTime, new Date(Math.floor((Date.now() - 7200e3) / 1000) * 1000).toISOString().slice(0, 17) + by('Version 2').sourceTime.slice(17));
    assert.equal(by('No guid').text, 'No guid here\n\nEscaped markup & entities\nsecond line'); assert.equal(by('No guid').url, `${base}/posts/no-guid`, 'a relative link is completed');
    assert.ok(by('No guid').sourceId.endsWith(`:${base}/posts/no-guid`), 'without a guid the link is the id'); assert.equal(by('No guid').author, 'jo@example.invalid'); assert.equal(by('No guid').authorName, 'Jo Example');
    assert.match(by('Neither guid').sourceId, /^[0-9a-f]{12}:h:[0-9a-f]{64}$/, 'without guid or link the id is made from title and date');
    const episode = a.find(e => e.kind === 'audio'); assert.equal(episode.text, ''); assert.ok(episode.sourceId.endsWith(':episode-9'));
    assert.equal(by('Database').text, 'Database slow\n\nWe are looking into it.'); assert.equal(by('Database').url, 'https://status.example.invalid/incidents/1', 'the alternate link, not the self link');
    assert.equal(by('Database').chatName, 'Status page', 'the name given in feeds.txt'); assert.equal(by('Database').authorName, 'Sam Example');
    assert.equal(by('Written as xhtml').text, 'Written as xhtml\n\nFirst part.\nSecond part.'); assert.equal(by('Written as xhtml').authorName, 'Ops team'); assert.equal(by('Written as xhtml').url, `${base}/incidents/2`);
    assert.equal(by('made-up video').text, 'A made-up video\n\nWhat the video is about.');
    assert.equal(by('First note').text, 'First note\n\nHello there'); assert.equal(by('First note').authorName, 'Robin Example'); assert.equal(by('without a title').chatName, 'Example notes');
    assert.equal(new Set(a.map(e => e.sourceId)).size, a.length);
    assert.match(r.err, /127\.0\.0\.1: http 500/, 'a broken feed is reported by host'); assert.match(r.err, /127\.0\.0\.1: asked to slow down/); assert.match(r.err, /feeds\.txt: line 8 is not a web address/);
    assert.equal(got.at(-1).status, 'ok', 'one broken feed does not stop or fail the rest');

    // Straight away again: nothing new, the feed that said "slow down" and the broken one are left alone, the blog is asked "only if changed".
    got.length = 0; r = await run(); logs.push(r); assert.deepEqual(items(), []); assert.ok(got.length >= 1);
    assert.equal(asked('/limited.xml'), 1, 'Retry-After is honoured'); assert.equal(asked('/broken'), 1, 'a failing feed is not retried at once');
    const again = reqs.filter(q => q.path === '/blog.xml').at(-1); assert.equal(again.etag, '"v5"'); assert.equal(again.since, 'Mon, 02 Nov 2026 10:00:00 GMT');

    // The core is down while two new entries arrive: nothing is remembered as sent, so they arrive once the core is back.
    rssItems.unshift(`<item><title>Fresh today</title><guid>post-3</guid><pubDate>${new Date().toUTCString()}</pubDate></item>`,
      `<item><title>Published late</title><guid>post-0</guid><pubDate>${ago(5 * 86400).toUTCString()}</pubDate></item>`);
    coreUp = false; got.length = 0; r = await run(); logs.push(r); assert.match(r.err, /core answered 500/); assert.deepEqual(items(), []);
    coreUp = true; r = await run(); logs.push(r); assert.doesNotMatch(r.err, /core|http|failed/);
    assert.deepEqual(items().map(e => [e.text, e.origin]).sort(), [['Fresh today', undefined], ['Published late', 'history']]);

    await new Promise(ok => setTimeout(ok, 2100));
    got.length = 0; r = await run(); logs.push(r); assert.deepEqual(items().map(e => [e.text, e.chatName, e.origin]), [['Worth the wait', 'Busy feed', 'history']], 'after the wait the busy feed is read');
    got.length = 0; r = await run(); logs.push(r); assert.deepEqual(items(), [], 'a last pass with nothing new sends only heartbeats'); assert.ok(got.length >= 1);

    assert.ok(reqs.length > 8 && reqs.every(q => q.method === 'GET'), 'feeds are only ever fetched with GET'); assert.ok(reqs.every(q => /read-only/.test(q.agent)));
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600);
    for (const l of logs) assert.ok(!(l.err + l.out).includes(SECRET) && !(l.err + l.out).includes('/atom'), 'a feed address is never printed');
    assert.ok(!fs.readFileSync(path.join(data, 'state.json'), 'utf8').includes(SECRET), 'and it is not copied into the state file');
  } finally { feeds.close(); core.close(); feeds.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('the feed list: notes, blank lines, names, and anything that is not a web address', () => {
  const { feeds, bad } = parseFeeds('# note\n\nhttps://a.example.invalid/feed?x=1&y=2\nMy name = https://b.example.invalid/rss\nhttps://a.example.invalid/feed?x=1&y=2\nftp://c.example.invalid/x\nnonsense\n');
  assert.deepEqual(feeds.map(f => [f.name, f.label, f.url]), [['', 'a.example.invalid', 'https://a.example.invalid/feed?x=1&y=2'], ['My name', 'My name', 'https://b.example.invalid/rss']]);
  assert.deepEqual(bad, [6, 7]); assert.notEqual(feeds[0].key, feeds[1].key);
});

test('the XML reader survives sloppy markup', () => {
  const doc = parseFeed(`<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "y">]><RSS><channel><title>Loose</title>
    <item><title>Unclosed <b>bold</title><guid>1</guid><description>a < b &unknown; &#x41;&#66; <![CDATA[<p>kept</p>]]></description></stray></item>
    <item><title>Second</title><guid>2</guid><dc:date>2026-11-01T10:00:00Z</dc:date></item></channel></RSS>`, 'https://x.example.invalid/');
  assert.equal(doc.title, 'Loose'); assert.deepEqual(doc.items.map(i => i.id), ['1', '2']);
  assert.equal(doc.items[0].title, 'Unclosed bold'); assert.equal(doc.items[0].body, 'a < b &unknown; AB kept'); assert.equal(doc.items[1].date, '2026-11-01T10:00:00Z');
  const pre = parseFeed('<a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:title>Prefixed</a:title><a:entry><a:id>e1</a:id><a:link href="https://x.example.invalid/e1"/></a:entry></a:feed>', 'https://x.example.invalid/');
  assert.equal(pre.title, 'Prefixed'); assert.equal(pre.items[0].link, 'https://x.example.invalid/e1');
  const old = parseFeed('<rdf:RDF><channel><title>One point oh</title></channel><item rdf:about="https://x.example.invalid/a"><title>Beside the channel</title></item></rdf:RDF>', 'https://x.example.invalid/');
  assert.equal(old.items[0].id, 'https://x.example.invalid/a');
  assert.throws(() => parseFeed('<html><body>not a feed</body></html>', 'https://x.example.invalid/'), /not a feed/); assert.throws(() => parseFeed('{"nope": 1}', 'https://x.example.invalid/'), /not a feed/);
  assert.equal(parseXml('<a x=\'1>2\' y="&amp;"><b/>t</a>').kids[0].attrs.x, '1>2');
  assert.equal(toText('<style>p{}</style><p>one</p><p>two&nbsp;&amp;&nbsp;three</p>'), 'one\ntwo & three');
});
