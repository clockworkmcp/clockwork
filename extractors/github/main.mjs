// GitHub extractor: reads the user's notifications through GitHub's REST API and posts new ones to Clockwork.
// Read-only by construction: every call to GitHub is a GET. Listing notifications does not mark them as read; the calls
// that do (PUT /notifications, PATCH and DELETE on a thread) are never made. It asks GitHub at most as often as GitHub's
// own X-Poll-Interval header allows, and sends If-Modified-Since so that "nothing new" costs GitHub almost nothing.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_GITHUB_PACE_MS', 1000);             // pause before every GitHub call
const FIRST_S = num('CLOCKWORK_GITHUB_FIRST_HOURS', 24) * 3600;    // history brought in on the first run
const REST_S = num('CLOCKWORK_GITHUB_REST_SECONDS', 60);           // pause between passes
const BACKOFF_S = num('CLOCKWORK_GITHUB_BACKOFF_SECONDS', 60);     // wait when GitHub says "slow down" without saying for how long
const MAX_WAIT_S = num('CLOCKWORK_GITHUB_MAX_WAIT_SECONDS', 120);  // a longer wait than this ends the pass; the next one starts after it
const COMMENTS = num('CLOCKWORK_GITHUB_COMMENTS', 1);              // 0: never fetch the latest comment, titles only
const ONCE = process.argv.includes('--once');
const SOURCE = 'github', PER_PAGE = 50, MAX_PAGES = 10, MAX_BODY = 4000;
const KIND = { PullRequest: 'Pull request', Issue: 'Issue', Commit: 'Commit', Release: 'Release', Discussion: 'Discussion', CheckSuite: 'Workflow run',
  RepositoryVulnerabilityAlert: 'Security alert', RepositoryDependabotAlertsThread: 'Security alert', RepositoryInvitation: 'Invitation' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json');
const readFile = f => { try { return fs.readFileSync(path.join(DATA, f), 'utf8').trim(); } catch { return ''; } };
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
const fail = (message, status = 'error', more = {}) => Object.assign(new Error(message), { status, ...more });

/** Where GitHub's API is: github.com unless an address for GitHub Enterprise is given (https://HOSTNAME/api/v3). */
function apiBase() {
  const raw = (process.env.CLOCKWORK_GITHUB_API || readFile('api') || 'https://api.github.com').replace(/\/+$/, '');
  let u; try { u = new URL(raw); } catch { throw fail('the GitHub API address is not a web address'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) throw fail('the GitHub API address must start with https://');
  return raw;
}

let lastContact = 0, notBefore = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

/** One GET to GitHub. A short "slow down" is waited out, a long one ends the pass. Redirects are not followed, so the token only goes where it was sent. */
async function gh(token, url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    const r = await fetch(url, { method: 'GET', redirect: 'manual', headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'clockwork-extractor', ...headers } });
    const retryAfter = r.headers.get('retry-after'), spent = r.headers.get('x-ratelimit-remaining') === '0', reset = Number(r.headers.get('x-ratelimit-reset'));
    if (r.status !== 429 && !(r.status === 403 && (retryAfter !== null || spent || /rate limit/i.test(await r.clone().text().catch(() => ''))))) return r;
    const wait = retryAfter !== null ? Math.max(1, Number(retryAfter) || 1) * 2 ** attempt : spent && reset ? Math.max(1, reset - Date.now() / 1000 + 1) : BACKOFF_S * 2 ** attempt;
    if (attempt >= 3 || wait > MAX_WAIT_S) throw fail(`github asked to slow down for ${Math.ceil(wait)} s`, 'rate_limited', { waitS: wait });
    await sleep(wait * 1000); await heartbeat();
  }
}

/** The page to open for a notification, worked out from the API address of its subject without asking GitHub again. */
export function htmlUrl(n) {
  const repo = n.repository?.html_url; if (!repo) return undefined;
  const m = /\/repos\/[^/]+\/[^/]+\/(issues|pulls|commits|discussions)\/([^/?#]+)$/.exec(n.subject?.url || '');
  if (m) return `${repo}/${{ issues: 'issues', pulls: 'pull', commits: 'commit', discussions: 'discussions' }[m[1]]}/${m[2]}`;
  return repo + ({ Release: '/releases', CheckSuite: '/actions', RepositoryVulnerabilityAlert: '/security/dependabot', RepositoryDependabotAlertsThread: '/security/dependabot',
    Discussion: '/discussions', RepositoryInvitation: '/invitations' }[n.subject?.type] || '');
}

/** One notification thread, with the latest comment (or the issue, pull request or release itself) when it could be read. */
export function toItem(n, latest, history) {
  const login = latest?.user?.login || latest?.author?.login, body = String(latest?.body ?? latest?.commit?.message ?? '').trim().slice(0, MAX_BODY);
  const type = n.subject?.type || '';
  return { sourceId: `${n.id}:${n.updated_at}`, threadId: String(n.id), author: login || 'github', authorName: login || 'GitHub',
    sourceTime: new Date(n.updated_at).toISOString(), direction: 'incoming', isGroup: true, kind: 'text',
    text: `[${n.reason}] ${KIND[type] || type || 'Notification'}: ${n.subject?.title || ''}` + (body ? `\n\n${login ? login + ': ' : ''}${body}` : ''),
    chatName: n.repository?.full_name, origin: history ? 'history' : undefined, url: (typeof latest?.html_url === 'string' && latest.html_url) || htmlUrl(n) };
}

/** The latest comment on a thread: one GET, only to the API itself. A repository the token cannot read is not asked again in this pass. */
async function latestComment(token, api, n, closed) {
  const u = n.subject?.latest_comment_url || n.subject?.url, repo = n.repository?.full_name;
  if (!COMMENTS || typeof u !== 'string' || !u.startsWith(api + '/') || closed.has(repo)) return null;
  const r = await gh(token, u);
  if (r.status === 403 || r.status === 404) { closed.add(repo); return null; }
  return r.ok ? r.json().catch(() => null) : null;
}

async function pass() {
  const token = process.env.CLOCKWORK_SECRET_TOKEN?.trim() || readFile('token');   // from the Keychain, handed over by Clockwork; the file is where it used to be kept
  if (!token) { await send([], 'needs_login'); return; }
  const api = apiBase(), state = loadState(); state.seen ||= {};
  if (Date.now() < Math.max(state.pollAfter || 0, notBefore)) { await send([], state.limited ? 'rate_limited' : 'ok'); return; }   // GitHub said when to come back
  await send([]);
  const first = !state.since, since = state.since || new Date(Date.now() - FIRST_S * 1000).toISOString();
  const threads = [], items = [], closed = new Set(); let lastModified = state.lastModified, stopped = null;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await gh(token, `${api}/notifications?all=true&since=${encodeURIComponent(since)}&per_page=${PER_PAGE}&page=${page}`, page === 1 && state.lastModified ? { 'if-modified-since': state.lastModified } : {});
      if (page === 1) { const p = r.headers.get('x-poll-interval'); notBefore = Date.now() + (p === null ? 60 : Math.max(0, Number(p) || 0)) * 1000; lastModified = r.headers.get('last-modified') || lastModified; }
      if (r.status === 304) break;
      if (r.status === 401 || r.status === 403) throw fail(`github did not accept the token (http ${r.status})`, 'needs_login');
      if (!r.ok) throw fail(`github notifications: http ${r.status}`);
      const list = await r.json(); threads.push(...list); if (list.length < PER_PAGE) break;
    }
    for (const n of threads.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))) {
      if (!n?.id || !n.updated_at || state.seen[n.id] === n.updated_at) continue;
      items.push(toItem(n, await latestComment(token, api, n, closed), first));
    }
  } catch (e) { if (e.status !== 'rate_limited') throw e; stopped = e; notBefore = Date.now() + Math.min(3600, e.waitS) * 1000; }
  for (let i = 0; i < items.length; i += 200) await send(items.slice(i, i + 200));
  // Only now, with the items accepted by the core, remember them. A pass that was cut short keeps its old place, so the rest is read next time.
  for (const it of items) state.seen[it.threadId] = it.sourceId.slice(it.threadId.length + 1);
  if (!stopped) { state.since = threads.reduce((m, n) => n.updated_at > m ? n.updated_at : m, since); state.lastModified = lastModified;
    for (const [id, at] of Object.entries(state.seen)) if (at < state.since) delete state.seen[id]; }
  state.pollAfter = notBefore; state.limited = !!stopped; saveState(state);
  if (items.length) console.log(`pass done: sent ${items.length}`);
  if (stopped) console.error(stopped.message);
  await send([], stopped ? 'rate_limited' : 'ok');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await send([], e.status || 'error').catch(() => {}); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
