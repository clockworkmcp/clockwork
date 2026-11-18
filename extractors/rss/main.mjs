// RSS extractor: reads the feeds listed in feeds.txt (RSS 2.0, RSS 1.0, Atom and JSON Feed) and posts new entries to Clockwork.
// Read-only by construction: the only thing it ever does to a feed is fetch it with GET. It asks politely: each feed at
// most once every 15 minutes, with "only if changed" headers, and it waits as long as a feed asks when told to slow down.
// A feed address can hold a private token, so addresses are never logged: a feed is named by its label or its host.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const POLL_S = num('CLOCKWORK_RSS_POLL_MINUTES', 15) * 60;       // how often one feed is fetched
const PACE_MS = num('CLOCKWORK_RSS_PACE_MS', 1000);              // pause before every fetch
const FIRST_S = num('CLOCKWORK_RSS_FIRST_HOURS', 24) * 3600;     // history brought in the first time a feed is seen
const REST_S = num('CLOCKWORK_RSS_REST_SECONDS', 60);            // pause between looks at which feeds are due
const AGENT = process.env.CLOCKWORK_RSS_USER_AGENT || 'clockwork-rss/1.0 (personal feed reader; read-only)';
const MAX_TEXT = 4000, MAX_BYTES = 5_000_000, MAX_NEW = 100, KEEP_S = 30 * 86400, TIMEOUT_MS = 30_000;
const ONCE = process.argv.includes('--once');
const SOURCE = 'rss';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const stateFile = path.join(DATA, 'state.json'), feedsFile = path.join(DATA, 'feeds.txt');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };

let lastContact = 0;
async function send(events, status = 'ok') {
  const core = e => Object.assign(e, { core: true });                 // a failure of the core is not a failure of a feed
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) }).catch(e => { throw core(new Error('could not reach the core')); });
  if (!r.ok) throw core(new Error(`core answered ${r.status}`)); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

/** feeds.txt: one address per line, or `name = address`. Blank lines and lines starting with # are skipped. */
export function parseFeeds(text) {
  const feeds = [], bad = [], seen = new Set();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim(); if (!line || line.startsWith('#')) return;
    const m = /^([^=]*?)\s*=\s*(\S+)$/.exec(line), named = m && !/^https?:/i.test(m[1]), address = named ? m[2] : line;
    let u; try { u = new URL(address); } catch {} if (!u || !/^https?:$/.test(u.protocol)) return bad.push(i + 1);
    if (seen.has(u.href)) return; seen.add(u.href);
    feeds.push({ url: u.href, key: sha(u.href).slice(0, 12), name: named ? m[1].trim() : '', host: u.hostname, label: (named && m[1].trim()) || u.hostname });
  });
  return { feeds, bad };
}

// ---- A small, forgiving XML reader: enough for feeds. Element and attribute names are lower-cased. ----
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', euro: '€', pound: '£', deg: '°', times: '×', eacute: 'é' };
export const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
  if (e[0] !== '#') return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
});
const TAG = /<(\/?)([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/y, ATTR = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
/** Returns a tree of { name, attrs, kids }, where kids are elements and strings in document order. Never throws on bad markup. */
export function parseXml(src) {
  const root = { name: '#root', attrs: {}, kids: [] }, stack = [root], put = s => { if (s) stack.at(-1).kids.push(s); };
  for (let i = 0; i < src.length;) {
    const lt = src.indexOf('<', i); if (lt < 0) { put(decode(src.slice(i))); break; }
    put(decode(src.slice(i, lt)));
    const skipTo = (mark, from = lt) => { const end = src.indexOf(mark, from); return end < 0 ? src.length : end + mark.length; };
    if (src.startsWith('<![CDATA[', lt)) { i = skipTo(']]>'); put(src.slice(lt + 9, src.indexOf(']]>', lt) < 0 ? src.length : i - 3)); continue; }
    if (src.startsWith('<!--', lt)) { i = skipTo('-->'); continue; }
    if (src.startsWith('<?', lt)) { i = skipTo('?>'); continue; }
    if (src.startsWith('<!', lt)) { const gt = src.indexOf('>', lt), sub = src.indexOf('[', lt); i = sub > 0 && gt > 0 && sub < gt ? skipTo(']>') : skipTo('>'); continue; }
    TAG.lastIndex = lt; const m = TAG.exec(src); if (!m) { put('<'); i = lt + 1; continue; }
    i = TAG.lastIndex; const name = m[2].toLowerCase();
    if (m[1]) { const at = stack.findLastIndex(n => n.name === name); if (at > 0) stack.length = at; continue; }     // a closing tag nobody opened is ignored
    const node = { name, attrs: {}, kids: [] }; for (const a of m[3].matchAll(ATTR)) node.attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4]);
    stack.at(-1).kids.push(node); if (!/\/\s*$/.test(m[3])) stack.push(node);
  }
  return root;
}
const BLOCK = /^(?:\w+:)?(p|div|br|li|h[1-6]|tr|blockquote|pre)$/;
const flat = n => n.kids.map(k => typeof k === 'string' ? k : flat(k) + (BLOCK.test(k.name) ? '\n' : '')).join('');
const els = (n, name) => n ? n.kids.filter(k => k.name === name) : [];
const el = (n, ...names) => { for (const name of names) { const k = n?.kids.find(k => k.name === name); if (k) return k; } };
const txt = (n, ...names) => { for (const name of names) { const t = flat(el(n, name) || { kids: [] }).trim(); if (t) return t; } return ''; };

const squash = s => s.replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
/** HTML to plain text: drops scripts and styles, turns paragraph and line breaks into new lines, removes every tag. */
export const toText = html => squash(decode(String(html).replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<li\b[^>]*>/gi, '\n- ').replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|h[1-6]|tr|blockquote|pre|ul|ol|table)\s*>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '')));
const abs = (href, base) => { if (!href) return ''; try { const u = new URL(href.trim(), base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };
const mediaKind = t => /^image\//.test(t || '') ? 'image' : /^video\//.test(t || '') ? 'video' : /^audio\//.test(t || '') ? 'audio' : t ? 'document' : undefined;

function fromRss(root, base) {
  const ch = el(root, 'channel') || root, nodes = [...els(ch, 'item'), ...(ch === root ? [] : els(root, 'item'))];      // RSS 1.0 keeps items beside the channel
  return { title: toText(txt(ch, 'title')), items: nodes.map(it => {
    const guid = el(it, 'guid'), id = txt(it, 'guid') || it.attrs['rdf:about'] || '', who = txt(it, 'dc:creator', 'author', 'itunes:author'), mail = /^(\S+@\S+)\s*\((.+)\)$/.exec(who);
    const link = txt(it, 'link') || el(it, 'atom:link')?.attrs.href || (guid?.attrs.ispermalink !== 'false' && /^https?:/i.test(id) ? id : '');
    return { id, title: toText(txt(it, 'title')), link: abs(link, base), body: toText(txt(it, 'content:encoded', 'description', 'itunes:summary')),
      author: mail ? mail[1] : who, authorName: mail ? mail[2] : who, date: txt(it, 'pubdate', 'dc:date', 'atom:updated'), media: mediaKind(el(it, 'enclosure')?.attrs.type) };
  }) };
}
function fromAtom(feed, base) {
  if (feed.attrs['xml:base']) base = abs(feed.attrs['xml:base'], base) || base;
  const pick = n => { const ls = els(n, 'link'), alt = l => (l.attrs.rel || 'alternate') === 'alternate'; return (ls.find(l => alt(l) && /html/.test(l.attrs.type || 'html')) || ls.find(alt) || ls[0])?.attrs.href || ''; };
  const feedAuthor = txt(el(feed, 'author'), 'name');
  return { title: toText(txt(feed, 'title')), items: els(feed, 'entry').map(e => {
    const c = el(e, 'content', 'summary') || el(el(e, 'media:group'), 'media:description'), raw = c ? flat(c) : '', who = txt(el(e, 'author'), 'name') || feedAuthor;
    return { id: txt(e, 'id'), title: toText(txt(e, 'title')), link: abs(pick(e), base), body: c?.attrs.type === 'text' || c?.name === 'media:description' ? squash(raw) : toText(raw),
      author: who, authorName: who, date: txt(e, 'published', 'updated'), media: mediaKind(els(e, 'link').find(l => l.attrs.rel === 'enclosure')?.attrs.type) };
  }) };
}
function fromJson(j, base) {
  if (!j || !Array.isArray(j.items)) throw new Error('not a feed (RSS, Atom or JSON Feed)');
  const name = o => String((o?.authors?.[0] || o?.author)?.name || ''), s = v => v === undefined || v === null ? '' : String(v);
  return { title: s(j.title), items: j.items.filter(it => it && typeof it === 'object').map(it => ({ id: s(it.id), title: s(it.title), link: abs(s(it.url || it.external_url), base),
    body: it.content_text ? squash(s(it.content_text)) : toText(s(it.content_html || it.summary)), author: name(it) || name(j), authorName: name(it) || name(j),
    date: s(it.date_published || it.date_modified), media: mediaKind(it.attachments?.[0]?.mime_type) })) };
}
/** Any supported feed document to { title, items: [{ id, title, link, body, author, authorName, date, media }] }. */
export function parseFeed(body, base) {
  if (body.trimStart().startsWith('{')) { let j; try { j = JSON.parse(body); } catch { throw new Error('not a feed (RSS, Atom or JSON Feed)'); } return fromJson(j, base); }
  const root = parseXml(body).kids.find(k => typeof k === 'object'), prefix = /^(\w+):feed$/.exec(root?.name || '')?.[1];
  if (prefix) (function strip(n) { if (n.name.startsWith(prefix + ':')) n.name = n.name.slice(prefix.length + 1); for (const k of n.kids) if (typeof k === 'object') strip(k); })(root);
  if (root?.name === 'feed') return fromAtom(root, base);
  if (root?.name === 'rss' || root?.name === 'rdf:rdf') return fromRss(root, base);
  throw new Error('not a feed (RSS, Atom or JSON Feed)');
}

async function readBody(r) {
  const chunks = []; let n = 0;
  if (r.body) for await (const c of r.body) { n += c.length; if (n > MAX_BYTES) throw new Error('the feed is larger than 5 MB'); chunks.push(c); }
  const buf = Buffer.concat(chunks);
  const charset = /charset=["']?([\w-]+)/i.exec(r.headers.get('content-type') || '')?.[1] || /^\s*<\?xml[^>]*encoding=["']([\w-]+)/i.exec(buf.subarray(0, 200).toString('latin1'))?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(buf); } catch { return new TextDecoder().decode(buf); }
}
/** How long a feed asked us to stay away, in seconds: `Retry-After` is a number of seconds or a date. An hour when it does not say. */
const retryAfter = (h, now) => { const s = h === null ? NaN : /^\s*\d+\s*$/.test(h) ? Number(h) : (Date.parse(h) - now) / 1000; return Number.isFinite(s) ? Math.min(86400, Math.max(1, Math.ceil(s))) : 3600; };

/** Fetches one feed. Returns its new items and the feed's state to remember once the core has them. Changes nothing itself. */
export async function visit(feed, before, now = Date.now()) {
  const st = structuredClone(before || {}), first = !st.seen, nowS = Math.floor(now / 1000); st.seen ||= {};
  const headers = { 'user-agent': AGENT, accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.5' };
  if (st.etag) headers['if-none-match'] = st.etag; if (st.modified) headers['if-modified-since'] = st.modified;
  let r; try { r = await fetch(feed.url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch (e) { throw new Error(`could not reach it (${e.cause?.code || e.name})`); }   // never e.message: it can hold the address
  if (r.status === 304) { await r.body?.cancel(); return { items: [], st }; }
  if (r.status === 429 || r.status === 503) { await r.body?.cancel(); throw Object.assign(new Error(`asked to slow down (http ${r.status})`), { wait: retryAfter(r.headers.get('retry-after'), now) }); }
  if (!r.ok) { await r.body?.cancel(); throw new Error(`http ${r.status}`); }
  const doc = parseFeed(await readBody(r), feed.url), chat = feed.name || doc.title || feed.host, items = [], inDoc = new Set();
  for (const it of doc.items) {
    const t = Date.parse(it.date), dated = !Number.isNaN(t), raw = it.id || it.link || 'h:' + sha(it.title + '\n' + it.date), id = raw.length > 150 ? 'h:' + sha(raw) : raw;
    if (inDoc.has(id)) continue; inDoc.add(id);
    const isNew = !(id in st.seen); st.seen[id] = nowS;
    if (!isNew || (first && !(dated && t >= now - FIRST_S * 1000))) continue;                       // the first visit brings only what is dated within the last day
    const text = [it.body.startsWith(it.title) ? '' : it.title, it.body].filter(Boolean).join('\n\n');
    items.push({ sourceId: `${feed.key}:${id}`, threadId: feed.key, author: it.author || feed.host, authorName: it.authorName || chat,
      sourceTime: new Date(dated ? Math.min(t, now) : now).toISOString(), direction: 'incoming', isGroup: true, kind: text ? 'text' : it.media || 'document',
      text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1).trimEnd() + '…' : text, chatName: chat, url: it.link || undefined,
      origin: first || (dated && t < now - FIRST_S * 1000) ? 'history' : undefined });
  }
  for (const id of Object.keys(st.seen)) if (st.seen[id] < nowS - KEEP_S) delete st.seen[id];          // an entry is forgotten a month after it left the feed
  st.etag = r.headers.get('etag') || undefined; st.modified = r.headers.get('last-modified') || undefined;
  return { items: items.sort((a, b) => a.sourceTime < b.sourceTime ? -1 : 1).slice(-MAX_NEW), st };
}

let warned = '';
async function pass() {
  let listed; try { listed = parseFeeds(fs.readFileSync(feedsFile, 'utf8')); } catch { listed = { feeds: [], bad: [] }; }
  if (listed.bad.length && warned !== listed.bad.join()) { warned = listed.bad.join(); console.error(`feeds.txt: line ${warned} is not a web address and was skipped`); }
  if (!listed.feeds.length) { await send([], 'needs_login'); return; }                            // nothing to read until the user lists a feed
  const state = loadState(); state.feeds ||= {};
  for (const key of Object.keys(state.feeds)) if (!listed.feeds.some(f => f.key === key)) delete state.feeds[key];
  const standing = () => listed.feeds.every(f => state.feeds[f.key]?.fails) ? 'error' : 'ok';
  const due = listed.feeds.filter(f => (state.feeds[f.key]?.nextAt || 0) <= Date.now());
  if (ONCE || !lastContact) await send([], standing()); else await heartbeat(standing());
  let sent = 0, fresh = 0, failed = 0;
  for (const feed of due) {
    await sleep(PACE_MS);
    try {
      const { items, st } = await visit(feed, state.feeds[feed.key]);
      for (let i = 0; i < items.length; i += 200) { const r = await send(items.slice(i, i + 200)); sent += Math.min(200, items.length - i); fresh += r.new || 0; }
      state.feeds[feed.key] = { ...st, fails: 0, nextAt: Date.now() + POLL_S * 1000 }; saveState(state);        // only after the core has this feed's items
    } catch (e) {
      if (e.core) throw e;                                                                                     // nothing was saved: the same items are sent next time
      failed++; const old = state.feeds[feed.key] || {}, fails = (old.fails || 0) + 1, wait = e.wait ?? Math.min(6 * 3600, Math.max(POLL_S, 60) * 2 ** Math.min(fails, 5));
      state.feeds[feed.key] = { ...old, fails, nextAt: Date.now() + wait * 1000 }; saveState(state);            // a failing feed is left alone for longer each time
      console.error(`${feed.label}: ${e.message}`);
    }
    await heartbeat(standing());
  }
  if (sent || failed) console.log(`pass done: sent ${sent}, ${fresh} new${failed ? `, ${failed} feed(s) failed` : ''}`);
  if (due.length) await send([], standing());
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
