// Slack extractor: reads the conversations the user is in through Slack's Web API and posts new messages to Clockwork.
// Read-only by construction: the app it uses is given history and read permissions only, so the token cannot post.
// It walks the user's conversations one at a time, slowly, and looks back over the last two days every so often to
// catch replies in threads, which Slack does not include in a conversation's main history.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const API = (process.env.CLOCKWORK_SLACK_API || 'https://slack.com/api').replace(/\/$/, '');
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_SLACK_PACE_MS', 1200);            // pause before every Slack call
const SWEEP_S = num('CLOCKWORK_SLACK_SWEEP_SECONDS', 900);       // how often a conversation is re-read for thread replies
const WINDOW_S = num('CLOCKWORK_SLACK_WINDOW_HOURS', 48) * 3600; // how far back threads are followed
const FIRST_S = num('CLOCKWORK_SLACK_FIRST_HOURS', 24) * 3600;   // history brought in the first time a conversation is seen
const REST_S = num('CLOCKWORK_SLACK_REST_SECONDS', 60);          // pause between passes over all conversations
const ONCE = process.argv.includes('--once');
const SOURCE = 'slack';
const SKIP = new Set(['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive',
  'group_join', 'group_leave', 'group_topic', 'group_purpose', 'group_name', 'pinned_item', 'unpinned_item', 'joiner_notification_for_inviter', 'reminder_add']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json'), tokenFile = path.join(DATA, 'token');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
const readToken = () => { try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; } };

let lastContact = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

/** One Slack Web API call. Waits out rate limits; a Slack error (`ok: false`) is thrown with Slack's own error word. */
async function slack(token, method, params = {}) {
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])) });
    if (r.status === 429 && attempt < 6) { const ra = r.headers.get('retry-after'); await sleep((ra === null ? 30 : Math.max(1, Number(ra) || 1)) * 1000); await heartbeat(); continue; }
    if (!r.ok) throw new Error(`slack ${method}: http ${r.status}`);
    const j = await r.json(); if (!j.ok) throw Object.assign(new Error(`slack ${method}: ${j.error}`), { slack: j.error }); return j;
  }
}
async function pages(token, method, params, key, maxPages = 20) {
  const out = []; let cursor;
  for (let i = 0; i < maxPages; i++) { const j = await slack(token, method, { ...params, cursor }); out.push(...(j[key] || [])); cursor = j.response_metadata?.next_cursor; if (!cursor) break; }
  return out;
}

const after = (a, b) => Number(a) > Number(b);
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function makeReader({ token, state, me }) {
  state.convs ||= {}; state.users ||= {};
  async function userName(id) {
    if (!id) return undefined; if (state.users[id]) return state.users[id];
    try { const u = (await slack(token, 'users.info', { user: id })).user; state.users[id] = u?.profile?.display_name || u?.real_name || u?.name || id; } catch { state.users[id] = id; }
    return state.users[id];
  }
  /** Slack's markup to plain text: <@U1> to @name, <#C1|general> to #general, <url|label> to label (url). */
  async function plain(text) {
    for (const id of new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map(m => m[1]))) await userName(id);
    return decode(text.replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => '@' + (state.users[id] || id) + (id === me.user_id ? ' (you)' : ''))
      .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1').replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1').replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, '$1')
      .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2 ($1)').replace(/<((?:https?|mailto):[^>]+)>/g, '$1'));
  }
  async function toItem(conv, m, history) {
    if (m.type !== 'message' || SKIP.has(m.subtype) || !m.ts) return null;
    const raw = m.text || (m.attachments || []).map(a => a.fallback || a.text || a.title || '').filter(Boolean).join('\n');
    const text = raw ? await plain(raw) : '', file = (m.files || [])[0];
    if (!text && !file) return null;
    const threaded = m.thread_ts && !conv.is_im && !conv.is_mpim, author = m.user || m.bot_id || m.username;
    return { sourceId: `${me.team_id}:${conv.id}:${m.ts}`, threadId: threaded ? `${conv.id}:${m.thread_ts}` : conv.id,
      author, authorName: m.user ? await userName(m.user) : (m.bot_profile?.name || m.username || 'app'),
      sourceTime: new Date(Number(m.ts) * 1000).toISOString(), direction: m.user === me.user_id ? 'outgoing' : 'incoming', isGroup: !conv.is_im,
      kind: text ? 'text' : /^image\//.test(file.mimetype || '') ? 'image' : /^video\//.test(file.mimetype || '') ? 'video' : /^audio\//.test(file.mimetype || '') ? 'audio' : 'document',
      text, chatName: conv.is_im ? undefined : conv.name, origin: history ? 'history' : undefined,
      url: `${String(me.url || '').replace(/\/?$/, '/')}archives/${conv.id}/p${m.ts.replace('.', '')}${m.thread_ts && m.thread_ts !== m.ts ? `?thread_ts=${m.thread_ts}&cid=${conv.id}` : ''}` };
  }
  /** New messages in one conversation since the last visit, including new replies in threads from the last two days. */
  async function visit(conv, now = Date.now() / 1000) {
    const st = state.convs[conv.id] ||= { threads: {} }, first = !st.last;
    const sweep = first || now - (st.sweepAt || 0) >= SWEEP_S, since = first ? String(now - FIRST_S) : st.last;
    const msgs = await pages(token, 'conversations.history', { channel: conv.id, oldest: sweep && !first ? String(now - WINDOW_S) : since, limit: 200 }, 'messages', 5);
    const items = []; let newest = st.last || '0';
    for (const m of msgs.sort((a, b) => Number(a.ts) - Number(b.ts))) {
      const isNew = after(m.ts, since);
      if (isNew) { const it = await toItem(conv, m, first); if (it) items.push(it); if (after(m.ts, newest)) newest = m.ts; }
      if (m.reply_count && m.latest_reply) {
        const seen = st.threads[m.ts] ?? (isNew ? since : String(st.sweepAt || now - FIRST_S));
        if (after(m.latest_reply, seen)) {
          const replies = await pages(token, 'conversations.replies', { channel: conv.id, ts: m.ts, oldest: seen, limit: 200 }, 'messages', 5);
          for (const r of replies) if (r.ts !== m.ts && after(r.ts, seen)) { const it = await toItem(conv, r, first); if (it) items.push(it); }
          st.threads[m.ts] = m.latest_reply;
        }
      }
    }
    st.last = after(newest, '0') ? newest : String(now); if (sweep) st.sweepAt = now;
    for (const ts of Object.keys(st.threads)) if (Number(ts) < now - WINDOW_S) delete st.threads[ts];
    return items;
  }
  async function conversations() {
    const all = await pages(token, 'users.conversations', { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200 }, 'channels');
    for (const c of all) if (c.is_im && !c.name) c.name = await userName(c.user);
    const rank = c => c.is_im ? 0 : c.is_mpim ? 1 : c.is_private ? 2 : 3;       // direct messages first
    return all.sort((a, b) => rank(a) - rank(b));
  }
  return { visit, conversations, toItem, plain };
}

async function pass() {
  const token = readToken();
  if (!token) { await send([], 'needs_login'); return; }
  let me; try { me = await slack(token, 'auth.test'); } catch (e) { await send([], ['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed', 'token_expired'].includes(e.slack) ? 'needs_login' : 'error'); throw e; }
  const state = loadState(), reader = makeReader({ token, state, me });
  await send([]);
  let sent = 0, fresh = 0, failed = 0;
  for (const conv of await reader.conversations()) {
    try {
      const items = await reader.visit(conv);
      for (let i = 0; i < items.length; i += 200) { const r = await send(items.slice(i, i + 200)); sent += Math.min(200, items.length - i); fresh += r.new || 0; }
      saveState(state);                                               // only after the core has this conversation's items
    } catch (e) { failed++; if (['invalid_auth', 'token_revoked', 'account_inactive'].includes(e.slack)) throw e; console.error(`${conv.id}: ${e.message}`); }
    await heartbeat();
  }
  if (sent || failed) console.log(`pass done: sent ${sent}, ${fresh} new${failed ? `, ${failed} conversation(s) failed` : ''}`);
  await send([], failed && !sent ? 'error' : 'ok');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
