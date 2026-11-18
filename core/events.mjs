// MCP Events: an agent (a ChatGPT dot, say) subscribes to "an item became urgent" (or "heads-up": an item it asked to see
// as it arrives) over MCP and is then woken by a signed webhook. Follows OpenAI's MCP Events guide: events/list,
// events/subscribe, events/unsubscribe, a callback check before the first delivery, Standard Webhooks signatures, one
// event per request. The push carries the item id (and for urgent items the source) only; the agent reads the content over MCP.
import crypto from 'node:crypto'; import https from 'node:https'; import dns from 'node:dns/promises'; import net from 'node:net';

export const EVENT = 'urgent_item', HEADS_UP = 'heads_up_item';
const sourceArg = { type: 'object', properties: { source: { type: 'string', description: 'Only items from this source (x, whatsapp or gmail). Omit for all sources.' } }, additionalProperties: false };
const DEFINITIONS = [{
  name: EVENT, delivery: ['webhook'],
  description: 'An incoming item (message, mail or post) was just classified as urgent for this user. The payload has the item id only; read it with get_event or get_urgent_updates, then tell the user.',
  inputSchema: sourceArg,
  payloadSchema: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' } }, required: ['id', 'source'] },
}, {
  name: HEADS_UP, delivery: ['webhook'],
  description: 'An incoming item you asked to see as it arrives (one of your heads-up rules matched it), or that the local model thinks may need attention. It is not yet labelled and the user has not been told. The payload has the item id only: read it with get_event, label it with submit_labels, and tell the user only if you judge that warranted.',
  inputSchema: sourceArg,
  payloadSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
}];
const NAMES = DEFINITIONS.map(d => d.name);
const HOUR = 3600e3, DAY = 24 * HOUR;
const TTL_DEFAULT = 30 * DAY, TTL_MIN = HOUR, TTL_MAX = 90 * DAY, MAX_SUBSCRIPTIONS = 20, MAX_BODY = 262144;

const rpc = (code, message, data) => Object.assign(new Error(message), { rpc: { code, message, ...(data ? { data } : {}) } });
const invalid = m => rpc(-32602, m);
const callbackError = reason => rpc(-32015, 'callback endpoint check failed: ' + reason, { reason });
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);

/** Standard Webhooks signature: HMAC-SHA256 over "id.timestamp.body" with the base64 key after the whsec_ prefix. */
export function sign(secret, id, timestamp, body) {
  return 'v1,' + crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
}
function validSecret(s) {
  if (typeof s !== 'string' || !/^whsec_[A-Za-z0-9+/]+=*$/.test(s)) return false;
  const n = Buffer.from(s.slice(6), 'base64').length; return n >= 24 && n <= 64;
}

// Callback URLs come from outside, so they may only reach public addresses: no loopback, private or link-local targets.
const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(a, p, 'ipv6');
export const isPublicAddress = (address, family = net.isIP(address)) => family !== 0 && !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');

/** POST to a public https URL. The address is checked and then pinned for the connection; redirects are not followed. */
export async function safePost(url, body, headers, timeoutMs = 10000) {
  const u = new URL(url); if (u.protocol !== 'https:') throw new Error('not_https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addrs.length || !addrs.every(a => isPublicAddress(a.address, a.family))) throw new Error('blocked_address');
  const pin = addrs[0];
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port: u.port || 443, path: u.pathname + u.search, method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      lookup: (_h, o, cb) => (o?.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)) }, res => {
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n <= 65536) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', e => reject(new Error(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'unreachable')));
    req.end(body);
  });
}

export function createEvents(store, { post = safePost, log = () => {}, maxAgeMs = 12 * HOUR } = {}) {
  const db = store.db;
  const find = id => db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
  const idFor = (principal, url, name, args) => 'sub_' + crypto.createHash('sha256').update(canon([principal, url, name, args])).digest('hex').slice(0, 32);
  const args = a => {
    if (a == null) return {};
    if (typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => k !== 'source')) throw invalid('arguments may only contain "source"');
    if (a.source !== undefined && (typeof a.source !== 'string' || !a.source || a.source.length > 40)) throw invalid('source must be a short string');
    return a.source ? { source: a.source } : {};
  };
  const headersFor = (sub, id, body) => { const ts = Math.floor(Date.now() / 1000);
    return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(sub.secret, id, ts, body), 'x-mcp-subscription-id': sub.id }; };

  /** Prove the callback is a live endpoint that holds the secret, before any event goes to it. */
  async function verify(sub) {
    const challenge = crypto.randomBytes(32).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    let r; try { r = await post(sub.url, body, headersFor(sub, 'msg_verification_' + crypto.randomBytes(12).toString('hex'), body)); }
    catch (e) { throw callbackError(['not_https', 'blocked_address', 'timeout'].includes(e.message) ? e.message : 'unreachable'); }
    if (r.status < 200 || r.status > 299) throw callbackError('status_' + r.status);
    let got; try { got = JSON.parse(r.text).challenge; } catch {}
    const a = Buffer.from(String(got ?? '')), b = Buffer.from(challenge);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw callbackError('challenge_failed');
  }

  async function subscribe(p = {}, principal) {
    if (!NAMES.includes(p.name)) throw invalid('unknown event');
    const a = args(p.arguments); const d = p.delivery || {};
    if (d.mode !== 'webhook') throw invalid('only webhook delivery is supported');
    let u; try { u = new URL(d.url); } catch { throw invalid('delivery.url must be a URL'); }
    if (u.protocol !== 'https:' || d.url.length > 2000) throw invalid('delivery.url must be an https URL');
    if (!validSecret(d.secret)) throw invalid('delivery.secret must be whsec_ followed by 24 to 64 base64-encoded bytes');
    if (p.ttlMs !== undefined && p.ttlMs !== null && !(Number(p.ttlMs) > 0)) throw invalid('ttlMs must be a positive number or null');
    const now = Date.now(), id = idFor(principal, d.url, p.name, a), old = find(id);
    if (!old && db.prepare('SELECT COUNT(*) n FROM subscriptions WHERE principal=?').get(principal).n >= MAX_SUBSCRIPTIONS) throw invalid('too many subscriptions');
    const sub = { id, url: d.url, secret: d.secret };
    // A callback checked in the last day with the same secret is not checked again on refresh.
    const fresh = old && old.secret === d.secret && now - old.verified_at < DAY;
    if (!fresh) await verify(sub);
    const expires = p.ttlMs === null ? null : now + Math.max(TTL_MIN, Math.min(TTL_MAX, p.ttlMs === undefined ? TTL_DEFAULT : Number(p.ttlMs)));
    const asked = p.cursor == null ? null : Number(p.cursor);
    if (asked !== null && !Number.isFinite(asked)) throw invalid('cursor is not one this server issued');
    const cursor = Math.min(asked ?? old?.cursor ?? now, now);
    db.prepare(`INSERT INTO subscriptions(id,principal,name,arguments,url,secret,cursor,expires_at,created_at,verified_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET secret=excluded.secret, cursor=excluded.cursor, expires_at=excluded.expires_at, verified_at=excluded.verified_at, failures=0, retry_at=0`)
      .run(id, principal, p.name, canon(a), d.url, d.secret, cursor, expires, now, fresh ? old.verified_at : now);
    log(`events: ${old ? 'refreshed' : 'new'} subscription ${id} for ${principal}`);
    deliver().catch(() => {});
    return { id, refreshBefore: expires === null ? null : new Date(expires).toISOString(), cursor: String(cursor), truncated: cursor < now - maxAgeMs };
  }

  function unsubscribe(p = {}, principal) {
    if (typeof p.delivery?.url !== 'string') throw invalid('delivery.url is required');
    db.prepare('DELETE FROM subscriptions WHERE id=? AND principal=?').run(idFor(principal, p.delivery.url, p.name, args(p.arguments)), principal);
    return {};
  }

  // Per event: which items are due after a cursor, the cursor position of one item, and what its push says.
  const KINDS = {
    [EVENT]: { due: cursor => store.urgentUpdates({ afterDecidedAt: cursor, maxAgeMs, limit: 50 }), at: it => it.decided_at,
      // Items the agent itself marked urgent are skipped: it already knows, and telling it again would loop.
      skip: it => it.stage === 'agent', data: it => ({ id: it.id, source: it.source, ...(it.answered ? { youWroteInThreadAfter: true } : {}) }) },
    // Items labelled since the heads-up was raised are left out by headsUpUpdates: someone has already looked.
    [HEADS_UP]: { due: cursor => store.headsUpUpdates({ afterAt: cursor, maxAgeMs, limit: 50 }), at: it => it.heads_up_at, skip: () => false, data: it => ({ id: it.id }) },
  };
  async function deliverTo(sub) {
    const only = JSON.parse(sub.arguments).source; let cursor = sub.cursor, sent = 0; const k = KINDS[sub.name]; if (!k) return 0;
    const save = extra => db.prepare(`UPDATE subscriptions SET cursor=?, sent=sent+?, ${extra} WHERE id=?`);
    for (const it of k.due(cursor)) {
      const at = k.at(it);
      if ((only && it.source !== only) || k.skip(it)) { cursor = at; continue; }
      const eventId = 'evt_' + crypto.createHash('sha256').update(`${sub.id}|${it.id}|${at}`).digest('hex').slice(0, 24);
      const body = JSON.stringify({ eventId, name: sub.name, timestamp: new Date(at).toISOString(), data: k.data(it), cursor: String(at) });
      let status, error;
      if (Buffer.byteLength(body) > MAX_BODY) status = 413;
      else try { status = (await post(sub.url, body, headersFor(sub, eventId, body))).status; } catch (e) { error = e.message; }
      if (status === 410) { db.prepare('DELETE FROM subscriptions WHERE id=?').run(sub.id); log(`events: ${sub.id} is gone at the receiver, removed`); return sent; }
      if (status >= 200 && status <= 299) sent++;
      else if (status !== 413) { // keep this item (and any decided in the same millisecond) for the retry; duplicates are allowed, gaps are not
        const failures = sub.failures + 1;
        save('failures=?, retry_at=?, last_error=?').run(Math.min(cursor, at - 1), sent, failures, Date.now() + Math.min(30 * 60e3, 15e3 * 2 ** failures), error || 'status ' + status, sub.id);
        log(`events: delivery to ${sub.id} failed (${error || status})`); return sent;
      }
      cursor = at;
    }
    if (sent) save('failures=0, retry_at=0, last_error=NULL, last_ok=?').run(cursor, sent, Date.now(), sub.id);
    else if (cursor !== sub.cursor) save('failures=failures').run(cursor, 0, sub.id);
    return sent;
  }
  let busy = null;
  /** Send every subscription the urgent items (or heads-ups) it has not had yet. Safe to call often; one run at a time. */
  function deliver() {
    return busy ??= (async () => {
      await null; // never finish in the same tick: the "finally" below must run after `busy` has been set, or it would stay set for good
      try {
        const now = Date.now(); let sent = 0;
        db.prepare('DELETE FROM subscriptions WHERE expires_at IS NOT NULL AND expires_at<?').run(now - 7 * DAY);
        for (const sub of db.prepare('SELECT * FROM subscriptions WHERE (expires_at IS NULL OR expires_at>?) AND retry_at<=?').all(now, now)) sent += await deliverTo(sub);
        return sent;
      } finally { busy = null; }
    })();
  }

  const list = () => db.prepare('SELECT id, principal, name, arguments, url, cursor, expires_at, created_at, failures, last_ok, last_error, sent FROM subscriptions ORDER BY created_at').all()
    .map(s => ({ id: s.id, principal: s.principal, event: s.name, arguments: JSON.parse(s.arguments), callbackHost: new URL(s.url).host, createdAt: new Date(s.created_at).toISOString(),
      expiresAt: s.expires_at ? new Date(s.expires_at).toISOString() : null, expired: !!s.expires_at && s.expires_at < Date.now(), delivered: s.sent,
      lastDelivery: s.last_ok ? new Date(s.last_ok).toISOString() : null, failing: s.failures ? s.last_error : undefined }));
  const remove = id => ({ removed: Number(db.prepare('DELETE FROM subscriptions WHERE id=?').run(String(id)).changes) });
  const status = () => { const l = list(); return l.length ? { subscriptions: l.length, active: l.filter(s => !s.expired).length, delivered: l.reduce((a, s) => a + s.delivered, 0), failing: l.filter(s => s.failing).length } : 'no subscriptions'; };

  return { definitions: () => ({ events: DEFINITIONS }), subscribe, unsubscribe, deliver, list, remove, status };
}
