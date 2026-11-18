// Outlook extractor: reads new mail in the inbox of an Outlook or Microsoft 365 account through Microsoft Graph and posts
// it to Clockwork. Read-only twice over: the sign-in asks for Mail.Read only, which cannot change a mailbox, and every
// request this file sends to Graph is a GET. It never marks as read, moves, deletes or sends.
// It asks Graph only for what changed since last time (a "delta" link kept in state.json), so it is light on the service.
import fs from 'node:fs'; import path from 'node:path';
import { DATA, readClient, readRefreshToken, refresh } from './login.mjs';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const GRAPH = (process.env.CLOCKWORK_OUTLOOK_GRAPH || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_OUTLOOK_PACE_MS', 1000);              // pause before every Graph call
const FIRST_MS = num('CLOCKWORK_OUTLOOK_FIRST_HOURS', 24) * 3600e3;  // history brought in on the first run
const REST_S = num('CLOCKWORK_OUTLOOK_REST_SECONDS', 120);           // pause between looks at the inbox
const MAX_PAGES = num('CLOCKWORK_OUTLOOK_MAX_PAGES', 40);            // pages of 50 messages read in one pass; the rest waits for the next
const RENEW = num('CLOCKWORK_OUTLOOK_RENEW_AFTER', 4000);            // Graph stops a filtered delta at 5,000 messages: start a new one before that
const ONCE = process.argv.includes('--once');
const SOURCE = 'outlook', MAX_TEXT = 6000, OVERLAP_MS = 5 * 60_000;
const SELECT = 'id,conversationId,subject,bodyPreview,body,from,sender,toRecipients,receivedDateTime,webLink,isDraft,hasAttachments';
const PREFER = 'outlook.body-content-type="text", IdType="ImmutableId", odata.maxpagesize=50';   // plain-text bodies, ids that survive a move to another folder

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
/** The optional `me` file: the user's own address or addresses, so mail they sent themself is marked outgoing. */
const readMe = () => { try { return new Set(fs.readFileSync(path.join(DATA, 'me'), 'utf8').toLowerCase().split(/[\s,;]+/).filter(a => a.includes('@'))); } catch { return new Set(); } };

let lastContact = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };
async function rest(ms) { for (let left = ms; left > 0; left -= 60_000) { await sleep(Math.min(left, 60_000)); await heartbeat(); } }

let access = null;                                                   // the short-lived key, kept in memory only
/** One GET on Microsoft Graph. Renews the key when it has run out, and waits as long as Graph says when it is busy. */
async function graph(client, url) {
  if (new URL(url).origin !== new URL(GRAPH).origin) throw new Error('Graph pointed at another host; not going there');   // the key goes to Graph and nowhere else
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    if (!access || Date.now() >= access.expiresAt) access = await refresh(client);
    const r = await fetch(url, { method: 'GET', headers: { authorization: 'Bearer ' + access.token, prefer: PREFER }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 401 && attempt === 0) { access = null; continue; }
    if ([429, 503, 504].includes(r.status) && attempt < 5) { const ra = Number(r.headers.get('retry-after')); await rest((ra > 0 ? Math.min(ra, 900) : 5 * 2 ** attempt) * 1000); continue; }
    if (!r.ok) { const code = (await r.json().catch(() => ({}))).error?.code; throw Object.assign(new Error(`graph: http ${r.status}${code ? ' ' + code : ''}`), { status: r.status, code }); }
    return r.json();
  }
}

const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
/** The address that starts a new round: everything that arrived in the inbox since `since`. */
const startUrl = since => `${GRAPH}/me/mailFolders/inbox/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent('receivedDateTime ge ' + iso(since))}`;
const stale = e => e.status === 410 || /syncState|resync/i.test(e.code || '');   // Graph has forgotten where we were: start a new round
const tidy = s => String(s || '').replace(/\r\n?/g, '\n').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const unHtml = s => s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ');

/** A Graph message to a Clockwork item, or null for what is not a new piece of mail (removals, drafts, read-state changes, mail from before the start). */
export function toItem(m, { me = new Set(), floor = 0, history = false } = {}) {
  if (!m?.id || m['@removed'] || m.isDraft || !m.receivedDateTime || !(Date.parse(m.receivedDateTime) >= floor)) return null;
  const from = (m.from || m.sender)?.emailAddress || {}, address = from.address ? String(from.address).toLowerCase() : undefined, subject = m.subject || '';
  const body = tidy(m.body?.contentType === 'html' ? unHtml(m.body.content || '') : m.body?.content) || tidy(m.bodyPreview), full = `Subject: ${subject}\n\n${body}`;
  return { sourceId: m.id, threadId: m.conversationId || m.id, author: address, authorName: from.name || undefined, sourceTime: new Date(m.receivedDateTime).toISOString(),
    direction: address && me.has(address) ? 'outgoing' : 'incoming', isGroup: false, kind: 'text', text: full.slice(0, MAX_TEXT), url: m.webLink || undefined, origin: history ? 'history' : undefined,
    metadata: { subject, to: (m.toRecipients || []).map(t => t.emailAddress?.address).filter(Boolean).join(', ') || undefined, attachments: m.hasAttachments || undefined, truncated: full.length > MAX_TEXT || undefined } };
}

async function pass() {
  const client = readClient();
  if (!client || !readRefreshToken()) { await send([], 'needs_login'); return; }
  const state = loadState(), me = readMe(), now = Date.now();
  if (!state.floor) Object.assign(state, { floor: iso(now - FIRST_MS), history: true });       // first run: the last day, marked as history
  const again = () => { state.count = 0; return startUrl(Math.max(Date.parse(state.floor), (Date.parse(state.newest) || 0) - OVERLAP_MS)); };
  let url = state.link && (state.count || 0) < RENEW ? state.link : again(), restarted = false, sent = 0, fresh = 0;
  try {
    if (!access || now >= access.expiresAt) access = await refresh(client);
    await send([]);
    for (let page = 0; page < MAX_PAGES; page++) {
      let j; try { j = await graph(client, url); } catch (e) { if (!stale(e) || restarted) throw e; restarted = true; url = again(); continue; }
      const items = (j.value || []).map(m => toItem(m, { me, floor: Date.parse(state.floor), history: state.history })).filter(Boolean).sort((a, b) => a.sourceTime < b.sourceTime ? -1 : 1);
      if (items.length) { const r = await send(items); sent += items.length; fresh += r.new || 0; }
      for (const it of items) if (!state.newest || it.sourceTime > state.newest) state.newest = it.sourceTime;
      state.count = (state.count || 0) + (j.value || []).length;
      const done = j['@odata.deltaLink']; url = done || j['@odata.nextLink'];
      if (!url) throw new Error('graph: an answer with no link to continue from');
      state.link = url; if (done) delete state.history;
      saveState(state);                                               // only after the core has this page's items
      if (done) break;
      await heartbeat();
    }
  } catch (e) { await send([], e.login ? 'needs_login' : 'error').catch(() => {}); throw e; }
  if (sent) console.log(`pass done: sent ${sent}, ${fresh} new`);
  await send([], 'ok');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
