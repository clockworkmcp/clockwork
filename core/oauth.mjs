// A small OAuth 2.1 authorization server, so an agent product that only speaks OAuth (ChatGPT's custom MCP servers)
// can be connected to this instance by its owner: authorization code + PKCE (S256), public clients, rotating refresh
// tokens, RFC 8414 / RFC 9728 discovery, dynamic client registration, and the `iss` response parameter (RFC 9207).
// The owner approves a connection on a page served here by entering the admin token. Whatever is connected this way
// gets the agent role: POST /mcp only. Enabled when CLOCKWORK_PUBLIC_URL and the admin token are both set.
import crypto from 'node:crypto';

const MIN = 60e3, DAY = 24 * 3600e3;
const CODE_TTL = 5 * MIN, ACCESS_TTL = 60 * MIN, REFRESH_TTL = 90 * DAY, MAX_CLIENTS = 50, MAX_FORM = 65536, SCOPE = 'clockwork';
// Where an approved connection may be sent back to. Exact URLs, or a prefix ending in "/" followed by one path segment.
const DEFAULT_REDIRECTS = 'https://chatgpt.com/connector_platform_oauth_redirect,https://chatgpt.com/connector/oauth/';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oerr = (error, description, status = 400) => Object.assign(new Error(description), { oauth: { error, error_description: description }, status });

export function createOAuth(store, { base = process.env.CLOCKWORK_PUBLIC_URL || '', adminToken = '', agentTeaches = false, log = () => {},
  redirects = (process.env.CLOCKWORK_OAUTH_REDIRECTS || DEFAULT_REDIRECTS).split(',').map(s => s.trim()).filter(Boolean) } = {}) {
  base = base.replace(/\/+$/, '');
  const enabled = /^https:\/\//.test(base) && !!adminToken;
  const resource = base + '/mcp', metadataUrl = base + '/.well-known/oauth-protected-resource';
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY, name TEXT, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_codes(hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_tokens(hash TEXT PRIMARY KEY, kind TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, client_name TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER);
    CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);`);

  const redirectAllowed = uri => { let u; try { u = new URL(uri); } catch { return false; }
    if (u.protocol !== 'https:' || u.hash || u.username || u.password) return false;
    return redirects.some(r => r.endsWith('/') ? uri.startsWith(r) && /^[A-Za-z0-9_.~-]+$/.test(uri.slice(r.length)) : uri === r); };
  const clientOrigins = new Set(redirects.map(r => new URL(r).origin));
  /** A client is one registered here, or (Client ID Metadata Documents) an https URL on an origin we already send people back to.
   *  The metadata document is not fetched: the redirect allowlist above is what decides where a code may go. */
  function client(id) {
    const row = db.prepare('SELECT * FROM oauth_clients WHERE id=?').get(String(id ?? ''));
    if (row) return { id: row.id, name: row.name || 'An app', uris: JSON.parse(row.redirect_uris) };
    try { const u = new URL(id); if (u.protocol === 'https:' && clientOrigins.has(u.origin)) return { id: String(id), name: u.hostname, uris: null }; } catch {}
    return null;
  }
  /** Checks an authorization request. Errors thrown here are shown to the person, never redirected, since the target is unproven. */
  function checkRequest(p) {
    const c = client(p.client_id); if (!c) throw oerr('invalid_client', 'This app is not registered with this Clockwork instance.');
    if (!redirectAllowed(p.redirect_uri) || (c.uris && !c.uris.includes(p.redirect_uri))) throw oerr('invalid_request', 'The return address is not one this Clockwork instance allows.');
    return c;
  }
  /** Problems the client should hear about: returned to it by redirect. */
  function requestProblem(p) {
    if (p.response_type !== 'code') return ['unsupported_response_type', 'only the code flow is supported'];
    if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge || '')) return ['invalid_request', 'PKCE with S256 is required'];
    if (p.resource && p.resource.replace(/\/+$/, '') !== resource && p.resource.replace(/\/+$/, '') !== base) return ['invalid_target', 'unknown resource'];
    return null;
  }
  const back = (uri, params) => { const u = new URL(uri); for (const [k, v] of Object.entries({ ...params, iss: base })) if (v != null && v !== '') u.searchParams.set(k, v); return u.toString(); };

  // Wrong approval secrets lock the page for a while, so the admin token cannot be guessed through it.
  let failures = 0, lockedUntil = 0;

  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}h1{font-size:1.3rem}ul{padding-left:1.2rem}
input{font:inherit;width:100%;box-sizing:border-box;padding:.6rem;margin:.4rem 0 1rem;border:1px solid #999;border-radius:6px}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#1a1a1a;color:#fff;cursor:pointer}
.err{color:#a40000}.muted{color:#555;font-size:.9rem}@media(prefers-color-scheme:dark){body{background:#161616;color:#eee}input{background:#222;color:#eee;border-color:#666}button{background:#eee;color:#111}.muted{color:#aaa}.err{color:#ff8a80}}</style></head><body>${body}</body></html>`;
  const FIELDS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];
  const consent = (p, c, error) => page('Connect to Clockwork', `<h1>Connect ${esc(c.name)} to your Clockwork?</h1>
<p>After you approve, it will be sent back to <strong>${esc(new URL(p.redirect_uri).host)}</strong> and will be able to:</p>
<ul><li>read your urgent and later queues and the messages in them</li><li>raise or lower items between urgent and later</li>
${agentTeaches ? '<li>label items to train your filter, including marking items as ignore</li><li>choose which messages wake it up as they arrive</li>' : ''}<li>ask to be woken when something urgent arrives</li></ul>
<p>It cannot change other settings, add data or see your tokens. You can cut it off at any time.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${FIELDS.map(k => `<input type="hidden" name="${k}" value="${esc(p[k] ?? '')}">`).join('')}
<label for="s">Your Clockwork admin token</label><input id="s" name="secret" type="password" autocomplete="off" required autofocus>
<button type="submit">Approve</button></form><p class="muted">Only approve if you started this connection yourself just now.</p>`);

  function issue(grant, clientId, clientName) {
    const now = Date.now(), access = 'cwa_' + rand(), refresh = 'cwr_' + rand();
    const ins = db.prepare('INSERT INTO oauth_tokens(hash,kind,grant_id,client_id,client_name,expires_at,created_at) VALUES (?,?,?,?,?,?,?)');
    ins.run(sha(access), 'access', grant, clientId, clientName, now + ACCESS_TTL, now); ins.run(sha(refresh), 'refresh', grant, clientId, clientName, now + REFRESH_TTL, now);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: SCOPE };
  }
  function token(p) {
    if (p.grant_type === 'authorization_code') {
      const row = db.prepare('SELECT * FROM oauth_codes WHERE hash=?').get(sha(String(p.code ?? '')));
      if (row) db.prepare('DELETE FROM oauth_codes WHERE hash=?').run(row.hash); // single use, whatever happens next
      if (!row || row.expires_at < Date.now() || row.client_id !== p.client_id || row.redirect_uri !== p.redirect_uri) throw oerr('invalid_grant', 'code is invalid or expired');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier || '') || !same(crypto.createHash('sha256').update(p.code_verifier).digest('base64url'), row.challenge)) throw oerr('invalid_grant', 'PKCE check failed');
      log(`oauth: connection approved for client ${sha(row.client_id).slice(0, 8)}`);
      return issue('g_' + rand(12), row.client_id, client(row.client_id)?.name ?? null);
    }
    if (p.grant_type === 'refresh_token') {
      const row = db.prepare(`SELECT * FROM oauth_tokens WHERE hash=? AND kind='refresh'`).get(sha(String(p.refresh_token ?? '')));
      if (!row || row.expires_at < Date.now() || (p.client_id && row.client_id !== p.client_id)) throw oerr('invalid_grant', 'refresh token is invalid or expired');
      // Rotation: the old pair stops working. A refresh token seen twice means it leaked, so the whole connection ends.
      if (row.used_at) { db.prepare('DELETE FROM oauth_tokens WHERE grant_id=?').run(row.grant_id); log('oauth: refresh token reuse, connection revoked'); throw oerr('invalid_grant', 'refresh token was already used'); }
      db.prepare(`DELETE FROM oauth_tokens WHERE grant_id=? AND kind='access'`).run(row.grant_id);
      db.prepare(`DELETE FROM oauth_tokens WHERE grant_id=? AND kind='refresh' AND hash!=?`).run(row.grant_id, row.hash);
      db.prepare('UPDATE oauth_tokens SET used_at=? WHERE hash=?').run(Date.now(), row.hash);
      return issue(row.grant_id, row.client_id, row.client_name);
    }
    throw oerr('unsupported_grant_type', 'use authorization_code or refresh_token');
  }
  function register(b) {
    const uris = b?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every(u => typeof u === 'string' && redirectAllowed(u))) throw oerr('invalid_redirect_uri', 'redirect_uris must be return addresses this instance allows');
    if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none') throw oerr('invalid_client_metadata', 'only public clients (token_endpoint_auth_method "none") are supported');
    // Registration is open by necessity; unused registrations are dropped so it cannot fill the database.
    db.prepare(`DELETE FROM oauth_clients WHERE created_at<? AND id NOT IN (SELECT client_id FROM oauth_tokens)`).run(Date.now() - DAY);
    if (db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n >= MAX_CLIENTS) throw oerr('temporarily_unavailable', 'too many registered apps', 503);
    const id = 'cwc_' + rand(18), name = String(b.client_name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60) || null;
    db.prepare('INSERT INTO oauth_clients VALUES (?,?,?,?)').run(id, name, JSON.stringify(uris), Date.now());
    return { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name ?? undefined, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  }

  const readBody = req => new Promise((resolve, reject) => { let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_FORM) { reject(oerr('invalid_request', 'body too large', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(/^application\/json\b/i.test(req.headers['content-type'] || '') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw))); } catch { reject(oerr('invalid_request', 'unreadable body')); } });
    req.on('error', reject); });

  const AS_META = { issuer: base, authorization_endpoint: base + '/oauth/authorize', token_endpoint: base + '/oauth/token', registration_endpoint: base + '/oauth/register',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: [SCOPE], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true };
  const RS_META = { resource, authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ['header'] };

  /** Serves the public OAuth routes. Returns false when the request is not one of them. */
  async function handle(req, res, url) {
    const path = url.pathname, m = req.method;
    const isOurs = path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-') || path === '/.well-known/openid-configuration';
    if (!enabled || !isOurs) return false;
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(obj)); };
    const html = (status, body, formTarget = '') => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formTarget}; frame-ancestors 'none'; base-uri 'none'` }); res.end(body); };
    const done = status => { log(`${new Date().toISOString()} ${m} ${path} ${status} oauth`); return true; };
    try {
      if (m === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) { json(200, RS_META); return true; }
      if (m === 'GET' && ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'].includes(path)) { json(200, AS_META); return true; }
      if (path === '/oauth/register' && m === 'POST') { json(201, register(await readBody(req))); return done(201); }
      if (path === '/oauth/token' && m === 'POST') { json(200, token(await readBody(req))); return done(200); }
      if (path === '/oauth/authorize' && (m === 'GET' || m === 'POST')) {
        const p = m === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
        let c; try { c = checkRequest(p); } catch (e) { html(400, page('Cannot connect', `<h1>Cannot connect</h1><p>${esc(e.message)}</p>`)); return done(400); }
        const problem = requestProblem(p);
        if (problem) { res.writeHead(302, { location: back(p.redirect_uri, { error: problem[0], error_description: problem[1], state: p.state }), 'cache-control': 'no-store' }); res.end(); return done(302); }
        const target = new URL(p.redirect_uri).origin;
        if (m === 'GET') { html(200, consent(p, c), target); return done(200); }
        if (Date.now() < lockedUntil) { html(429, consent(p, c, 'Too many wrong attempts. Try again in a few minutes.'), target); return done(429); }
        if (!same(String(p.secret ?? '').trim(), adminToken)) {
          failures++; if (failures >= 5) lockedUntil = Date.now() + Math.min(60, 5 * 2 ** (failures - 5)) * MIN;
          log('oauth: wrong approval secret'); html(403, consent(p, c, 'That is not the admin token for this Clockwork.'), target); return done(403);
        }
        failures = 0;
        const code = rand(); db.prepare('DELETE FROM oauth_codes WHERE expires_at<?').run(Date.now());
        db.prepare('INSERT INTO oauth_codes VALUES (?,?,?,?,?)').run(sha(code), c.id, p.redirect_uri, p.code_challenge, Date.now() + CODE_TTL);
        res.writeHead(302, { location: back(p.redirect_uri, { code, state: p.state }), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return done(302);
      }
      json(404, { error: 'not found' }); return true;
    } catch (e) {
      if (!e.oauth) log(`oauth error ${path}: ${e.message}`);
      json(e.oauth ? e.status || 400 : 500, e.oauth || { error: 'server_error' }); return done(e.status || 500);
    }
  }

  /** True when `bearer` is a live access token issued here. */
  function verify(bearer) {
    if (!enabled || !bearer?.startsWith('cwa_')) return false;
    const row = db.prepare(`SELECT expires_at FROM oauth_tokens WHERE hash=? AND kind='access'`).get(sha(bearer));
    return !!row && row.expires_at > Date.now();
  }
  const grants = () => db.prepare(`SELECT grant_id, client_name, MIN(created_at) since, MAX(created_at) last, MAX(expires_at) until FROM oauth_tokens WHERE expires_at>? AND used_at IS NULL GROUP BY grant_id ORDER BY since`).all(Date.now())
    .map(g => ({ id: g.grant_id, app: g.client_name, lastRenewed: new Date(g.last).toISOString(), validUntil: new Date(g.until).toISOString() }));
  const revoke = id => ({ revoked: Number((id ? db.prepare('DELETE FROM oauth_tokens WHERE grant_id=?').run(String(id)) : db.prepare('DELETE FROM oauth_tokens').run()).changes) > 0 });
  return { enabled, handle, verify, grants, revoke, challenge: `Bearer resource_metadata="${metadataUrl}", scope="${SCOPE}"`, scope: SCOPE,
    status: () => enabled ? { connections: grants().length } : 'off' };
}
