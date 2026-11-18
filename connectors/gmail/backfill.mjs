// One-off: pull older mail into the core so the teacher can label it (more training data, especially urgent examples).
// Usage: node backfill.mjs [days=180] [max=1500]. Skips promotions and social mail, which are already well covered.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createClient, toEvent } from './gmail.mjs';
const dir = process.env.CLOCKWORK_GMAIL_DATA || path.join(os.homedir(), '.clockwork', 'v2', 'gmail');
const c = JSON.parse(fs.readFileSync(path.join(dir, 'client.json'), 'utf8')).installed, tok = JSON.parse(fs.readFileSync(path.join(dir, 'token.json'), 'utf8'));
const client = createClient({ clientId: c.client_id, clientSecret: c.client_secret, refreshToken: tok.refresh_token });
const days = Number(process.argv[2] || 180), max = Number(process.argv[3] || 1500);
const core = (process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600').replace(/\/$/, ''), token = process.env.CLOCKWORK_INGEST_TOKEN || process.env.CLOCKWORK_TOKEN || '';
const ids = []; let pageToken;
do {
  const page = await client.get('messages', { q: `newer_than:${days}d -in:chats -category:promotions -category:social`, maxResults: 500, pageToken });
  for (const m of page?.messages || []) ids.push(m.id); pageToken = page?.nextPageToken;
} while (pageToken && ids.length < max);
let fetched = 0, fresh = 0;
for (let i = 0; i < Math.min(ids.length, max); i += 5) {
  const msgs = await Promise.all(ids.slice(i, i + 5).map(id => client.get(`messages/${id}`, { format: 'full' })));
  const events = msgs.map(m => m && toEvent(m)).filter(Boolean); fetched += events.length;
  const r = await fetch(`${core}/ingest/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ source: 'gmail', events }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); fresh += (await r.json()).new;
}
console.log(JSON.stringify({ listed: ids.length, fetched, new: fresh }));
