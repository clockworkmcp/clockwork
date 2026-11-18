// Gmail connector library: read-only API access, message -> event mapping, incremental sync by history id.
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SKIP_LABELS = new Set(['DRAFT', 'SPAM', 'TRASH', 'CHAT']);
const MAX_TEXT = 6000;

export class HistoryGap extends Error {}

export function createClient({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  let token, expires = 0;
  async function accessToken() {
    if (token && Date.now() < expires) return token;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    if (clientSecret) body.set('client_secret', clientSecret);
    const r = await fetchImpl(TOKEN_URL, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Google token refresh failed (${r.status}${j.error ? ' ' + j.error : ''}); run the auth step again if access was revoked`);
    token = j.access_token; expires = Date.now() + Math.max(0, (j.expires_in ?? 3600) - 60) * 1000; return token;
  }
  async function get(path, params = {}) {
    const url = new URL(path, API);
    for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) if (x !== undefined) url.searchParams.append(k, x);
    for (let attempt = 0; ; attempt++) {
      const r = await fetchImpl(url, { headers: { authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(30000) });
      if (r.status === 401 && attempt === 0) { token = undefined; continue; }
      // Gmail reports per-user rate limits as 403 with a rateLimit reason, not only as 429.
      const limited = r.status === 429 || (r.status === 403 && /rateLimit/i.test(await r.clone().text().catch(() => '')));
      if ((limited || r.status >= 500) && attempt < 6) { await new Promise(res => setTimeout(res, 1000 * 2 ** attempt)); continue; }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Gmail API ${path.split('?')[0]} answered ${r.status}`);
      return r.json();
    }
  }
  return { get };
}

const b64 = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const header = (payload, name) => payload?.headers?.find(h => h.name?.toLowerCase() === name)?.value;
function htmlToText(html) {
  return html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) ? String.fromCodePoint(c) : ' '; })
    .replace(/[ \t ​‌͏]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function bodyOf(payload) {
  let plain = '', html = '', attachments = 0;
  (function walk(p) {
    if (!p) return;
    if (p.filename) { attachments++; return; }
    if (p.mimeType === 'text/plain' && p.body?.data) plain += b64(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data) html += b64(p.body.data);
    for (const c of p.parts || []) walk(c);
  })(payload);
  const text = (plain.trim() || htmlToText(html)).replace(/\r\n/g, '\n');
  return { text, attachments, fromHtml: !plain.trim() && !!html };
}
function parseFrom(v = '') {
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(v);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim().toLowerCase() } : { email: v.trim().toLowerCase() || undefined };
}

/** Map a Gmail message (format=full) to a Clockwork event, or null when it should not be ingested. */
export function toEvent(msg) {
  const labels = msg.labelIds || [];
  if (labels.some(l => SKIP_LABELS.has(l))) return null;
  const from = parseFrom(header(msg.payload, 'from')), subject = header(msg.payload, 'subject') || '';
  const { text, attachments, fromHtml } = bodyOf(msg.payload);
  const body = text || msg.snippet || '';
  const full = `Subject: ${subject}\n\n${body}`;
  return {
    sourceId: msg.id, threadId: msg.threadId, feed: labels.includes('SENT') ? 'sent' : 'inbox',
    author: from.email, authorName: from.name, sourceTime: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined,
    direction: labels.includes('SENT') ? 'outgoing' : 'incoming', kind: 'text', text: full.slice(0, MAX_TEXT),
    metadata: { subject, to: header(msg.payload, 'to'), labels, attachments: attachments || undefined, truncated: full.length > MAX_TEXT || undefined,
      bodySource: text ? (fromHtml ? 'html' : 'plain') : 'snippet', bulk: !!header(msg.payload, 'list-unsubscribe') || undefined },
  };
}

async function fetchMessages(client, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = await Promise.all(ids.slice(i, i + 10).map(id => client.get(`messages/${id}`, { format: 'full' })));
    for (const m of batch) {
      if (!m) continue; // a 404 means the message was deleted meanwhile
      let e;
      // One malformed message must never stall the whole mailbox: fall back to its snippet.
      try { e = toEvent(m); } catch { e = toEvent({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, snippet: m.snippet, payload: { headers: m.payload?.headers } }); }
      if (e) out.push(e);
    }
  }
  return out;
}

/** One sync pass. Returns { events, state, bootstrapped, gap }. The caller persists `state` only after delivering `events`. */
export async function sync(client, state = {}, { bootstrapDays = 3, maxBootstrap = 500 } = {}) {
  if (state.historyId) {
    const ids = new Set(); let pageToken, latest = state.historyId, gap = false;
    do {
      const page = await client.get('history', { startHistoryId: state.historyId, historyTypes: 'messageAdded', maxResults: 500, pageToken });
      if (page === null) { gap = true; break; } // cursor too old: Google no longer has the history
      for (const h of page.history || []) for (const a of h.messagesAdded || []) if (a.message?.id) ids.add(a.message.id);
      if (page.historyId) latest = page.historyId; pageToken = page.nextPageToken;
    } while (pageToken);
    if (!gap) return { events: await fetchMessages(client, [...ids]), state: { ...state, historyId: latest }, bootstrapped: false, gap: false };
    const again = await sync(client, {}, { bootstrapDays: Math.max(bootstrapDays, 7), maxBootstrap });
    return { ...again, gap: true, state: { ...again.state, gaps: (state.gaps || 0) + 1 } };
  }
  // First run: note the mailbox position first, then read recent mail, so nothing arriving meanwhile is missed.
  const profile = await client.get('profile');
  if (!profile?.historyId) throw new Error('Gmail profile has no history id');
  const ids = []; let pageToken;
  do {
    const page = await client.get('messages', { q: `newer_than:${bootstrapDays}d -in:chats`, maxResults: 100, pageToken });
    for (const m of page?.messages || []) ids.push(m.id);
    pageToken = page?.nextPageToken;
  } while (pageToken && ids.length < maxBootstrap);
  return { events: await fetchMessages(client, ids.slice(0, maxBootstrap)), state: { historyId: String(profile.historyId), email: profile.emailAddress, gaps: state.gaps || 0 }, bootstrapped: true, gap: false };
}
