// Gmail connector: `node main.mjs auth` once to grant read-only access, then `node main.mjs` to keep syncing to the core.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import crypto from 'node:crypto';
import { createClient, sync, SCOPE } from './gmail.mjs';

const dir = process.env.CLOCKWORK_GMAIL_DATA || path.join(os.homedir(), '.clockwork', 'v2', 'gmail');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = n => path.join(dir, n);
const readJson = (p, d) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d;
const writePrivate = (p, obj) => { fs.writeFileSync(p + '.tmp', JSON.stringify(obj), { mode: 0o600 }); fs.renameSync(p + '.tmp', p); };

function oauthClient() {
  // A Google "Desktop app" OAuth client file, as downloaded from the Google Cloud console.
  const p = process.env.CLOCKWORK_GMAIL_CLIENT || file('client.json');
  if (!fs.existsSync(p)) throw new Error(`Google OAuth client file not found at ${p}`);
  const c = JSON.parse(fs.readFileSync(p, 'utf8')).installed;
  if (!c?.client_id) throw new Error('OAuth client file is not a Desktop app client');
  return c;
}

async function auth() {
  const c = oauthClient(); const verifier = crypto.randomBytes(48).toString('base64url'); const stateParam = crypto.randomBytes(16).toString('hex');
  const server = http.createServer(); await new Promise(r => server.listen(Number(process.env.CLOCKWORK_GMAIL_AUTH_PORT || 0), '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: c.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent',
    state: stateParam, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  console.log(`Open this address in your browser and approve read-only Gmail access:\n\n${url}\n`);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for approval')), 10 * 60e3);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== '/oauth/callback') { res.writeHead(404); return res.end(); }
      const ok = u.searchParams.get('state') === stateParam && u.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }); res.end(ok ? 'Gmail is connected to Clockwork. You can close this tab.' : 'Authorization failed.');
      clearTimeout(timer); ok ? resolve(u.searchParams.get('code')) : reject(new Error(`authorization failed: ${u.searchParams.get('error') || 'state mismatch'}`));
    });
  }).finally(() => server.close());
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: c.client_id, client_secret: c.client_secret || '', redirect_uri: redirect, code_verifier: verifier }) });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error(`token exchange failed (${r.status}${j.error ? ' ' + j.error : ''})`);
  writePrivate(file('token.json'), { refresh_token: j.refresh_token, scope: j.scope, obtainedAt: new Date().toISOString() });
  console.log('Gmail access saved.');
}

async function run() {
  const c = oauthClient(); const tok = readJson(file('token.json'));
  if (!tok?.refresh_token) throw new Error('Not authorized yet: run `node main.mjs auth` first');
  const client = createClient({ clientId: c.client_id, clientSecret: c.client_secret, refreshToken: tok.refresh_token });
  const core = (process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600').replace(/\/$/, ''), token = process.env.CLOCKWORK_INGEST_TOKEN || process.env.CLOCKWORK_TOKEN || '';
  const every = Number(process.env.CLOCKWORK_GMAIL_POLL_SECONDS || 60) * 1000, once = process.argv.includes('--once');
  const beat = state => fetch(`${core}/ingest/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ source: 'gmail', events: [], status: state }), signal: AbortSignal.timeout(15000) }).catch(() => {});
  for (;;) {
    const status = { at: new Date().toISOString() };
    try {
      const res = await sync(client, readJson(file('state.json'), {}), { bootstrapDays: Number(process.env.CLOCKWORK_GMAIL_BOOTSTRAP_DAYS || 3) });
      let fresh = 0;
      for (let i = 0; i < res.events.length; i += 50) {
        const r = await fetch(`${core}/ingest/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ source: 'gmail', events: res.events.slice(i, i + 50) }) });
        if (!r.ok) throw new Error(`core answered ${r.status}`);
        fresh += (await r.json()).new;
      }
      writePrivate(file('state.json'), res.state); // only after the core has everything, so a failed delivery is retried
      if (!res.events.length) await beat('ok'); // nothing new: still tell the core this connector is up
      Object.assign(status, { ok: true, fetched: res.events.length, new: fresh, bootstrapped: res.bootstrapped, gap: res.gap, historyId: res.state.historyId });
    } catch (e) { Object.assign(status, { ok: false, error: e.message }); if (!/core answered|fetch failed/.test(e.message)) await beat('error'); }
    writePrivate(file('status.json'), status); console.log(JSON.stringify(status));
    if (once) return; await new Promise(r => setTimeout(r, every));
  }
}

(process.argv[2] === 'auth' ? auth() : run()).catch(e => { console.error(e.message); process.exit(1); });
