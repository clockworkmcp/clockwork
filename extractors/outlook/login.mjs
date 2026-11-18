// Sign-in for the Outlook extractor, with Microsoft's "device code" flow: this program shows an address and a short code,
// the user enters the code in their own browser, and Microsoft hands this program a key to read mail (Mail.Read) and to
// stay signed in (offline_access). No web server is started and there is no client secret. `clockwork connect outlook` runs it.
// It is also the one place that talks to login.microsoftonline.com: main.mjs imports refresh() from here.
import fs from 'node:fs'; import path from 'node:path';

export const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const LOGIN = (process.env.CLOCKWORK_OUTLOOK_LOGIN || 'https://login.microsoftonline.com').replace(/\/$/, '');
export const SCOPE = 'https://graph.microsoft.com/Mail.Read offline_access';
const tokenFile = path.join(DATA, 'token.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const writePrivate = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file + '.tmp', JSON.stringify(obj), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
/** client.json: { "clientId": "...", "tenant": "common" | "organizations" | "consumers" | "<tenant id>" }. Null when missing or unusable. */
export function readClient() {
  try { const c = JSON.parse(fs.readFileSync(path.join(DATA, 'client.json'), 'utf8')), clientId = String(c.clientId || '').trim(), tenant = String(c.tenant || 'common').trim();
    return clientId && /^[A-Za-z0-9.-]+$/.test(tenant) ? { clientId, tenant } : null; } catch { return null; }
}
export const readRefreshToken = () => { try { return JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refresh_token || ''; } catch { return ''; } };

/** One POST to Microsoft's sign-in service. These two addresses are the only place this extractor ever sends a POST outside this machine. */
async function post(client, what, params) {
  const r = await fetch(`${LOGIN}/${client.tenant}/oauth2/v2.0/${what}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, ...params }), signal: AbortSignal.timeout(30_000) });
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
}
const keep = j => writePrivate(tokenFile, { refresh_token: j.refresh_token, scope: j.scope, obtainedAt: new Date().toISOString() });

/** A fresh access token from the saved sign-in. Microsoft sends a new refresh token each time, which replaces the saved one.
 *  When Microsoft no longer accepts the saved sign-in the error has `login: true`: the user has to sign in again. */
export async function refresh(client) {
  const saved = readRefreshToken();
  if (!saved) throw Object.assign(new Error('not signed in yet'), { login: true });
  const { ok, status, j } = await post(client, 'token', { grant_type: 'refresh_token', refresh_token: saved, scope: SCOPE });
  if (!ok || !j.access_token) throw Object.assign(new Error(`Microsoft did not renew the sign-in (${status}${j.error ? ' ' + j.error : ''})`), { login: ['invalid_grant', 'interaction_required', 'consent_required'].includes(j.error) });
  if (j.refresh_token && j.refresh_token !== saved) keep(j);
  return { token: j.access_token, expiresAt: Date.now() + Math.max(0, (Number(j.expires_in) || 3600) - 120) * 1000 };
}

/** The whole sign-in: ask for a code, show it, wait for the user to enter it in their browser, save the result. */
export async function signIn(client, say = console.log) {
  const start = await post(client, 'devicecode', { scope: SCOPE });
  if (!start.ok || !start.j.device_code) throw new Error(`Microsoft would not start the sign-in (${start.status}${start.j.error ? ' ' + start.j.error : ''}). Check the client id and tenant in client.json, and that "Allow public client flows" is on for the app.`);
  const { device_code, user_code, verification_uri } = start.j, until = Date.now() + (Number(start.j.expires_in) || 900) * 1000;
  let every = Math.max(1, Number(start.j.interval) || 5);
  say(`To let Clockwork read your Outlook mail (read-only):\n\n  1. Open ${verification_uri} in your browser\n  2. Enter the code ${user_code}\n  3. Sign in and approve\n\nWaiting for you to finish (the code works for ${Math.round((until - Date.now()) / 60000)} minutes)...`);
  while (Date.now() < until) {
    await sleep(every * 1000);
    const { j } = await post(client, 'token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code });
    if (j.access_token) { if (!j.refresh_token) throw new Error('Microsoft signed you in but gave no way to stay signed in: add the offline_access permission to the app and try again.'); keep(j); return; }
    if (j.error === 'authorization_pending') continue;
    if (j.error === 'slow_down') { every += 5; continue; }
    throw new Error(j.error === 'authorization_declined' ? 'The sign-in was declined.' : j.error === 'expired_token' ? 'The code ran out before the sign-in was finished. Run this again.' : `The sign-in failed (${j.error || 'no answer'}).`);
  }
  throw new Error('The code ran out before the sign-in was finished. Run this again.');
}

if (process.argv[1]?.endsWith('/login.mjs')) {
  try {
    const client = readClient(); if (!client) throw new Error(`No usable client.json in ${DATA}. It should hold { "clientId": "...", "tenant": "common" }: see README.md.`);
    await signIn(client); console.log(`Signed in. The sign-in is saved in ${tokenFile}.`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
