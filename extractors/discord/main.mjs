// Discord extractor: reads the text channels a bot of the user's own can see, through Discord's official REST API,
// and posts new messages to Clockwork. It only ever sends GET requests: it never posts, reacts or acknowledges anything,
// and it opens no gateway connection, so the bot never even shows as online.
// It uses a BOT token only. A personal account token ("self-bot") is against Discord's terms and is not supported.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const API = (process.env.CLOCKWORK_DISCORD_API || 'https://discord.com/api/v10').replace(/\/$/, '');
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_DISCORD_PACE_MS', 1000);              // pause before every Discord call
const FIRST_MS = num('CLOCKWORK_DISCORD_FIRST_HOURS', 24) * 3600e3;  // history brought in the first time a channel is seen
const REST_S = num('CLOCKWORK_DISCORD_REST_SECONDS', 60);            // pause between passes over all channels
const DENIED_MS = num('CLOCKWORK_DISCORD_DENIED_MINUTES', 60) * 60e3; // how long a channel that answered 403 is left alone
const MAX_PAGES = num('CLOCKWORK_DISCORD_MAX_PAGES', 5);             // pages of 100 messages read from one channel in one pass
const ONCE = process.argv.includes('--once');
const SOURCE = 'discord', AGENT = 'DiscordBot (clockwork, 1)', EPOCH = 1420070400000n;
const TEXT_CHANNELS = new Set([0, 5]);                               // GUILD_TEXT and GUILD_ANNOUNCEMENT
const MESSAGES = new Set([0, 19, 20, 23]);                           // ordinary messages, replies and answers to commands; the rest are notices

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json'), tokenFile = path.join(DATA, 'token');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
const readLine = name => { try { return fs.readFileSync(path.join(DATA, name), 'utf8').trim(); } catch { return ''; } };
const readToken = () => readLine('token').replace(/^Bot\s+/i, '');
/** channels.txt: one channel id per line; anything after # is a comment. No file (or no ids in it) means every channel. */
const allowList = () => { const ids = readLine('channels.txt').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(l => /^\d+$/.test(l)); return ids.length ? new Set(ids) : null; };

let lastContact = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };
/** A long wait, in pieces, so Clockwork keeps hearing from this program while Discord makes it wait. */
async function rest(ms) { for (let left = ms; left > 0; left -= 60_000) { await sleep(Math.min(left, 60_000)); await heartbeat(); } }

// Discord's rate limits: each route belongs to a bucket (named in X-RateLimit-Bucket) that says how many calls are left and
// when it refills, and there is one limit over everything. A call waits for both before it is made, never after a refusal only.
const routeBucket = new Map(), buckets = new Map(); let globalUntil = 0;
/** One GET on Discord's API. `route` is the path with its channel or server id in it, which is what a bucket is counted per. */
async function discord(token, route, params = {}) {
  const url = `${API}${route}?${new URLSearchParams(params)}`.replace(/\?$/, '');
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    const b = buckets.get(routeBucket.get(route) || route);
    const wait = Math.max(globalUntil - Date.now(), b && b.remaining <= 0 ? b.resetAt - Date.now() : 0);
    if (wait > 0) await rest(wait);
    const r = await fetch(url, { method: 'GET', headers: { authorization: 'Bot ' + token, 'user-agent': AGENT }, signal: AbortSignal.timeout(30_000) });
    const h = k => r.headers.get(k), key = h('x-ratelimit-bucket') ? `${h('x-ratelimit-bucket')}:${route}` : route;
    if (h('x-ratelimit-bucket')) routeBucket.set(route, key);
    if (h('x-ratelimit-remaining') !== null && h('x-ratelimit-reset-after') !== null)
      buckets.set(key, { remaining: Number(h('x-ratelimit-remaining')), resetAt: Date.now() + Number(h('x-ratelimit-reset-after')) * 1000 + 50 });
    if (r.status === 429) {
      const j = await r.json().catch(() => ({})), secs = Number(j.retry_after ?? h('retry-after') ?? 5), until = Date.now() + Math.max(0.05, Number.isFinite(secs) ? secs : 5) * 1000 + 50;
      if (j.global || h('x-ratelimit-global') === 'true') globalUntil = until; else buckets.set(key, { remaining: 0, resetAt: until });
      if (attempt < 5) continue;                                     // the wait happens at the top of the loop, before the next call
    }
    if (!r.ok) throw Object.assign(new Error(`discord ${route.replace(/\d{5,}/g, '…')}: http ${r.status}`), { status: r.status });
    return r.json();
  }
}

/** Discord ids ("snowflakes") carry their creation time, so "since yesterday" can be asked for as an id. */
export const snowflake = ms => String((BigInt(Math.floor(ms)) - EPOCH) << 22n);
const newer = (a, b) => BigInt(a) > BigInt(b);
const nameOf = u => u?.global_name || u?.username || 'someone';
const kindOf = a => /^image\//.test(a?.content_type || '') ? 'image' : /^video\//.test(a?.content_type || '') ? 'video' : /^audio\//.test(a?.content_type || '') ? 'audio' : 'document';

export function makeReader({ token, state, me, channelNames = {} }) {
  state.channels ||= {};
  /** Discord's markup to plain text: <@1> to @name, <#2> to #channel, <:wave:3> to :wave:, <t:1700000000> to a date. */
  function plain(text, m = {}) {
    const users = Object.fromEntries((m.mentions || []).map(u => [u.id, nameOf(u)]));
    return text.replace(/<@!?(\d+)>/g, (_, id) => '@' + (users[id] || 'someone') + (me && id === me ? ' (you)' : ''))
      .replace(/<@&\d+>/g, '@role').replace(/<#(\d+)>/g, (_, id) => '#' + (channelNames[id] || 'channel'))
      .replace(/<a?:(\w+):\d+>/g, ':$1:').replace(/<\/([^:>]+):\d+>/g, '/$1')
      .replace(/<t:(-?\d+)(?::[a-zA-Z])?>/g, (all, s) => { const d = new Date(Number(s) * 1000); return Number.isNaN(d.getTime()) ? all : d.toISOString(); });
  }
  /** True for a message that arrived with nothing in it, which is what Discord sends when the bot may not see message content. */
  const blank = m => MESSAGES.has(m.type) && !m.content && !m.attachments?.length && !m.embeds?.length && !m.sticker_items?.length && !m.poll;
  function toItem(guild, ch, m, history) {
    if (!MESSAGES.has(m.type) || !m.id || !m.author) return null;
    const raw = m.content || (m.embeds || []).map(e => [e.title, e.description].filter(Boolean).join('\n')).filter(Boolean).join('\n') || (m.poll?.question?.text ? `Poll: ${m.poll.question.text}` : '');
    const text = raw ? plain(raw, m) : '', file = (m.attachments || [])[0], sticker = (m.sticker_items || [])[0];
    if (!text && !file && !sticker) return null;
    return { sourceId: `${guild.id}:${ch.id}:${m.id}`, threadId: ch.id, author: m.author.id, authorName: nameOf(m.author),
      sourceTime: new Date(m.timestamp).toISOString(), direction: me && m.author.id === me ? 'outgoing' : 'incoming', isGroup: true,
      kind: text ? 'text' : file ? kindOf(file) : 'image', text, chatName: `${guild.name} #${ch.name}`, origin: history ? 'history' : undefined,
      url: `https://discord.com/channels/${guild.id}/${ch.id}/${m.id}` };
  }
  /** New messages in one channel since the last visit. Returns { items, denied, empty }; the state is moved on only when there is something to keep. */
  async function visit(guild, ch, now = Date.now()) {
    const st = state.channels[ch.id] ||= { last: snowflake(now - FIRST_MS), history: true };
    if (st.deniedAt && now - st.deniedAt < DENIED_MS) return { items: [], denied: true };
    delete st.deniedAt;
    const items = []; let last = st.last, seen = 0, blanks = 0, more = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      let batch;
      try { batch = await discord(token, `/channels/${ch.id}/messages`, { after: last, limit: 100 }); }
      catch (e) { if (e.status !== 403 && e.status !== 404) throw e; st.deniedAt = now; return { items: [], denied: true }; }   // not allowed in: leave it alone for a while
      for (const m of batch.sort((a, b) => newer(a.id, b.id) ? 1 : -1)) {
        seen++; const it = toItem(guild, ch, m, st.history); if (it) items.push(it); else if (blank(m)) blanks++;
        if (newer(m.id, last)) last = m.id;
      }
      more = batch.length >= 100; if (!more) break;
    }
    if (seen && blanks === seen) return { items: [], empty: true };   // nothing readable at all: do not move on, so nothing is lost once the bot may read content
    st.last = last; if (!more) delete st.history;
    return { items };
  }
  /** Every text channel in every server the bot is in, as [{ guild, channel }], kept to the allow-list when there is one. */
  async function channels(allow) {
    const guilds = []; let after;
    for (let i = 0; i < 10; i++) { const page = await discord(token, '/users/@me/guilds', after ? { limit: 200, after } : { limit: 200 }); guilds.push(...page); if (page.length < 200) break; after = page.at(-1).id; }
    const out = [];
    for (const guild of guilds) {
      let list; try { list = await discord(token, `/guilds/${guild.id}/channels`); } catch (e) { if (e.status === 401) throw e; console.error(`server ${guild.id}: ${e.message}`); continue; }
      for (const c of list) { channelNames[c.id] = c.name; if (TEXT_CHANNELS.has(c.type) && (!allow || allow.has(c.id))) out.push({ guild, channel: c }); }
    }
    return out;
  }
  return { visit, channels, toItem, plain };
}

async function pass() {
  const token = readToken();
  if (!token) { await send([], 'needs_login'); return; }
  const state = loadState(), me = readLine('me').replace(/\D/g, ''), reader = makeReader({ token, state, me });
  let list; try { list = await reader.channels(allowList()); } catch (e) { await send([], e.status === 401 ? 'needs_login' : 'error'); throw e; }
  await send([]);
  let sent = 0, fresh = 0, failed = 0, empty = 0;
  for (const { guild, channel } of list) {
    try {
      const res = await reader.visit(guild, channel);
      for (let i = 0; i < res.items.length; i += 200) { const r = await send(res.items.slice(i, i + 200)); sent += Math.min(200, res.items.length - i); fresh += r.new || 0; }
      if (res.empty) empty++;
      saveState(state);                                               // only after the core has this channel's items
    } catch (e) { failed++; if (e.status === 401) { await send([], 'needs_login').catch(() => {}); throw e; } console.error(`${channel.id}: ${e.message}`); }
    await heartbeat();
  }
  if (sent || failed) console.log(`pass done: sent ${sent}, ${fresh} new${failed ? `, ${failed} channel(s) failed` : ''}`);
  if (empty && !sent) console.error(`${empty} channel(s) have messages but Discord sent them without their text: switch on "Message Content Intent" for the bot (Developer Portal, Bot page).`);
  await send([], failed && !sent ? 'error' : empty && !sent ? 'needs_intent' : 'ok');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
