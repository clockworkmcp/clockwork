// GitLab extractor: reads the user's pending to-do items through GitLab's REST API and posts new ones to Clockwork.
// Read-only by construction: every call to GitLab is a GET of the to-do list, with a token that can only read.
// The calls that mark a to-do as done (POST /todos/:id/mark_as_done, POST /todos/mark_as_done) are never made.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_GITLAB_PACE_MS', 1000);             // pause before every GitLab call
const REST_S = num('CLOCKWORK_GITLAB_REST_SECONDS', 120);          // pause between passes
const BACKOFF_S = num('CLOCKWORK_GITLAB_BACKOFF_SECONDS', 60);     // wait when GitLab says "too many requests" without saying for how long
const MAX_WAIT_S = num('CLOCKWORK_GITLAB_MAX_WAIT_SECONDS', 120);  // a longer wait than this ends the pass; the next one starts after it
const ONCE = process.argv.includes('--once');
const SOURCE = 'gitlab', PER_PAGE = 100, MAX_PAGES = 10, MAX_BODY = 4000;
const KIND = { MergeRequest: 'Merge request', Issue: 'Issue', Commit: 'Commit', Epic: 'Epic', WorkItem: 'Work item', 'DesignManagement::Design': 'Design', 'AlertManagement::Alert': 'Alert',
  'WikiPage::Meta': 'Wiki page', Key: 'SSH key', Vulnerability: 'Vulnerability', Project: 'Project', Namespace: 'Group' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json');
const readFile = f => { try { return fs.readFileSync(path.join(DATA, f), 'utf8').trim(); } catch { return ''; } };
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
const fail = (message, status = 'error', more = {}) => Object.assign(new Error(message), { status, ...more });

/** Where GitLab's API is: gitlab.com unless the `host` file names a GitLab of your own (https://gitlab.example.com). */
function apiBase() {
  const raw = (process.env.CLOCKWORK_GITLAB_API || (readFile('host') || 'https://gitlab.com').replace(/\/+$/, '') + '/api/v4').replace(/\/+$/, '');
  let u; try { u = new URL(raw); } catch { throw fail('the GitLab address in the host file is not a web address'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) throw fail('the GitLab address must start with https://');
  return raw;
}

let lastContact = 0, notBefore = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

/** One GET to GitLab. A short "too many requests" is waited out, a long one ends the pass. Redirects are not followed, so the token only goes where it was sent. */
async function gl(token, url) {
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    const r = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'private-token': token, accept: 'application/json', 'user-agent': 'clockwork-extractor' } });
    if (r.status !== 429) return r;
    const retryAfter = r.headers.get('retry-after'), wait = (retryAfter !== null ? Math.max(1, Number(retryAfter) || 1) : BACKOFF_S) * 2 ** attempt;
    if (attempt >= 3 || wait > MAX_WAIT_S) throw fail(`gitlab asked to slow down for ${Math.ceil(wait)} s`, 'rate_limited', { waitS: wait });
    await sleep(wait * 1000); await heartbeat();
  }
}

/** A to-do changes its `updated_at` when GitLab adds to it, so the two together name one thing to look at. */
const stamp = t => String(t.updated_at || t.created_at || '');

/** One to-do item: what happened ([mentioned], [review_requested], ...), what it is about, and what was said. */
export function toItem(t, history) {
  const target = t.target || {}, type = t.target_type || '', ref = target.iid != null ? (type === 'MergeRequest' ? ' !' : ' #') + target.iid : '';
  const title = String(target.title || target.name || '').trim(), body = String(t.body || '').trim().slice(0, MAX_BODY), place = t.project?.path_with_namespace || t.group?.full_path;
  return { sourceId: `${t.id}:${stamp(t)}`, threadId: `${place || 'user'}:${type}:${target.iid ?? target.id ?? t.id}`,
    author: t.author?.username, authorName: t.author?.name || t.author?.username || 'GitLab',
    sourceTime: new Date(stamp(t) || Date.now()).toISOString(), direction: 'incoming', isGroup: !!place, kind: 'text',
    text: `[${t.action_name}] ${KIND[type] || type.split('::').pop() || 'To-do'}${ref}${title ? ': ' + title : ''}` + (body && body !== title ? '\n\n' + body : ''),
    chatName: place, origin: history ? 'history' : undefined, url: t.target_url || undefined };
}

async function pass() {
  const token = readFile('token');
  if (!token) { await send([], 'needs_login'); return; }
  const api = apiBase(), state = loadState(); state.seen ||= {};
  if (Date.now() < Math.max(state.pollAfter || 0, notBefore)) { await send([], 'rate_limited'); return; }   // GitLab said when to come back
  await send([]);
  const todos = []; let whole = false;
  try {
    for (let page = 1, n = 0; n < MAX_PAGES && page; n++) {
      const r = await gl(token, `${api}/todos?state=pending&per_page=${PER_PAGE}&page=${page}`);
      if (r.status === 401 || r.status === 403) throw fail(`gitlab did not accept the token (http ${r.status})`, 'needs_login');
      if (!r.ok) throw fail(`gitlab todos: http ${r.status}`);
      const list = await r.json(), next = r.headers.get('x-next-page'); todos.push(...list);
      page = next === null ? (list.length === PER_PAGE ? page + 1 : 0) : Number(next) || 0; whole = !page;
    }
  } catch (e) {
    if (e.status !== 'rate_limited') throw e;
    notBefore = Date.now() + Math.min(3600, e.waitS) * 1000; state.pollAfter = notBefore; saveState(state);
    console.error(e.message); await send([], 'rate_limited'); return;
  }
  const first = !state.started, fresh = todos.filter(t => t?.id != null && state.seen[t.id] !== stamp(t)).sort((a, b) => Date.parse(stamp(a)) - Date.parse(stamp(b)));
  const items = fresh.map(t => toItem(t, first));
  for (let i = 0; i < items.length; i += 200) await send(items.slice(i, i + 200));
  // Only now, with the items accepted by the core, remember them. To-dos that are no longer pending are forgotten.
  state.seen = { ...(whole ? {} : state.seen), ...Object.fromEntries(todos.filter(t => t?.id != null).map(t => [t.id, stamp(t)])) };
  state.started = true; state.pollAfter = 0; saveState(state);
  if (items.length) console.log(`pass done: sent ${items.length}`);
  await send([], 'ok');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await send([], e.status || 'error').catch(() => {}); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
