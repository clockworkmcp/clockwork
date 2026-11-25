// GitHub repository extractor: reads the public activity list of the repositories you name (issues, pull requests, comments,
// reviews, stars, forks, pushes, releases) through GitHub's REST API and posts what is new to Clockwork.
// Read-only by construction: every call to GitHub is a GET. It asks at most as often as GitHub's X-Poll-Interval header
// allows and sends If-None-Match, so "nothing new" costs GitHub almost nothing.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_GITHUB_PACE_MS', 1000);             // pause before every GitHub call
const FIRST_S = num('CLOCKWORK_GITHUB_FIRST_HOURS', 24) * 3600;    // history brought in on the first run
const BACKOFF_S = num('CLOCKWORK_GITHUB_BACKOFF_SECONDS', 60);     // wait when GitHub says "slow down" without saying for how long
const MAX_WAIT_S = num('CLOCKWORK_GITHUB_MAX_WAIT_SECONDS', 120);  // a longer wait than this ends the pass; the next one starts after it
const ONCE = process.argv.includes('--once');
const SOURCE = 'github', ACCOUNT = 'repos', PER_PAGE = 100, MAX_PAGES = 3, MAX_BODY = 4000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json');
const readFile = f => { try { return fs.readFileSync(path.join(DATA, f), 'utf8').trim(); } catch { return ''; } };
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
const fail = (message, status = 'error', more = {}) => Object.assign(new Error(message), { status, ...more });
const words = s => String(s || '').split(/[\s,]+/).map(w => w.trim()).filter(w => w && !w.startsWith('#'));

/** The repositories to watch ("owner/name"), from CLOCKWORK_GITHUB_REPOS or the file `repos`, and the logins whose own activity is left out. */
export const repoList = raw => [...new Set(words(raw).map(r => r.replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/+$/g, '')).filter(r => /^[\w.-]+\/[\w.-]+$/.test(r)))];
const repos = () => repoList(process.env.CLOCKWORK_GITHUB_REPOS || readFile('repos'));
const skipped = () => new Set(words(process.env.CLOCKWORK_GITHUB_REPO_SKIP || readFile('skip')).map(l => l.toLowerCase()));
// A token is only needed for a private repository. Without one GitHub allows 60 calls an hour, so the pauses are longer.
const token = () => process.env.CLOCKWORK_SECRET_TOKEN?.trim() || '';   // from the Keychain or the host's secret store, handed over by Clockwork; never read from a file
const REST_S = () => num('CLOCKWORK_GITHUB_REST_SECONDS', token() ? 60 : 300);

/** Where GitHub's API is: github.com unless an address for GitHub Enterprise is given (https://HOSTNAME/api/v3). */
function apiBase() {
  const raw = (process.env.CLOCKWORK_GITHUB_API || readFile('api') || 'https://api.github.com').replace(/\/+$/, '');
  let u; try { u = new URL(raw); } catch { throw fail('the GitHub API address is not a web address'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) throw fail('the GitHub API address must start with https://');
  return raw;
}
export const webBase = api => process.env.CLOCKWORK_GITHUB_WEB || (api === 'https://api.github.com' ? 'https://github.com' : api.replace(/\/api\/v3$/, ''));

let lastContact = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, account: ACCOUNT, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

/** One GET to GitHub. A short "slow down" is waited out, a long one ends the pass. Redirects are not followed, so the token only goes where it was sent. */
async function gh(tok, url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    const r = await fetch(url, { method: 'GET', redirect: 'manual', headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'clockwork-extractor', ...headers } });
    const retryAfter = r.headers.get('retry-after'), spent = r.headers.get('x-ratelimit-remaining') === '0', reset = Number(r.headers.get('x-ratelimit-reset'));
    if (r.status !== 429 && !(r.status === 403 && (retryAfter !== null || spent || /rate limit/i.test(await r.clone().text().catch(() => ''))))) return r;
    const wait = retryAfter !== null ? Math.max(1, Number(retryAfter) || 1) * 2 ** attempt : spent && reset ? Math.max(1, reset - Date.now() / 1000 + 1) : BACKOFF_S * 2 ** attempt;
    if (attempt >= 3 || wait > MAX_WAIT_S) throw fail(`github asked to slow down for ${Math.ceil(wait)} s`, 'rate_limited', { waitS: wait });
    await sleep(wait * 1000); await heartbeat();
  }
}

const cut = s => String(s ?? '').trim().slice(0, MAX_BODY);

/** One activity entry as a Clockwork item, or null for kinds that say nothing (a deleted branch of a bot, an empty payload). */
export function toItem(ev, web, history) {
  const repo = ev.repo?.name || '', p = ev.payload || {}, who = ev.actor?.login || 'github', home = `${web}/${repo}`;
  const subject = p.issue || p.pull_request || p.discussion, n = subject?.number ?? p.number, title = subject?.title ? ` ${subject.title}` : '';
  const ref = n ? `#${n}${title}` : '', thread = n ? `${repo}#${n}` : null, isPr = !!(p.pull_request || p.issue?.pull_request);
  const page = n ? `${home}/${isPr ? 'pull' : p.discussion ? 'discussions' : 'issues'}/${n}` : home;
  const said = body => cut(body) ? `\n\n${who}: ${cut(body)}` : '';
  let text, url = page, threadId = thread;
  switch (ev.type) {
    case 'WatchEvent': text = `[star] ${who} starred ${repo}`; url = `${web}/${who}`; threadId = `${repo}:stars`; break;
    case 'ForkEvent': text = `[fork] ${who} forked ${repo}${p.forkee?.full_name ? ' to ' + p.forkee.full_name : ''}`; url = p.forkee?.html_url || home; threadId = `${repo}:forks`; break;
    case 'IssuesEvent': text = `[issue ${p.action}] ${ref}` + (p.action === 'opened' ? said(p.issue?.body) : ''); url = p.issue?.html_url || page; break;
    case 'IssueCommentEvent': text = `[comment] on ${isPr ? 'pull request' : 'issue'} ${ref}` + said(p.comment?.body); url = p.comment?.html_url || page; break;
    case 'PullRequestEvent': text = `[pull request ${p.action === 'closed' && p.pull_request?.merged ? 'merged' : p.action}] ${ref}` + (p.action === 'opened' ? said(p.pull_request?.body) : ''); url = p.pull_request?.html_url || page; break;
    case 'PullRequestReviewEvent': text = `[review ${String(p.review?.state || p.action || '').toLowerCase().replace('_', ' ')}] on pull request ${ref}` + said(p.review?.body); url = p.review?.html_url || page; break;
    case 'PullRequestReviewCommentEvent': text = `[review comment] on pull request ${ref}${p.comment?.path ? ` (${p.comment.path})` : ''}` + said(p.comment?.body); url = p.comment?.html_url || page; break;
    case 'CommitCommentEvent': text = `[commit comment] on ${String(p.comment?.commit_id || '').slice(0, 7)}` + said(p.comment?.body); url = p.comment?.html_url || home; threadId = `${repo}:commit:${p.comment?.commit_id || ''}`; break;
    case 'DiscussionEvent': text = `[discussion ${p.action}] ${ref}` + (p.action === 'created' ? said(p.discussion?.body) : ''); url = p.discussion?.html_url || page; break;
    case 'DiscussionCommentEvent': text = `[comment] on discussion ${ref}` + said(p.comment?.body); url = p.comment?.html_url || page; break;
    case 'PushEvent': { const branch = String(p.ref || '').replace('refs/heads/', ''), commits = (p.commits || []).map(c => `- ${String(c.message || '').split('\n')[0]}`).join('\n');
      text = `[push] ${who} pushed${p.size ? ` ${p.size} commit(s)` : ''} to ${branch || 'a branch'}` + (commits ? `\n\n${cut(commits)}` : '');
      url = p.before && p.head ? `${home}/compare/${p.before}...${p.head}` : `${home}/commits/${branch}`; threadId = `${repo}:push:${branch}`; break; }
    case 'ReleaseEvent': text = `[release ${p.action}] ${p.release?.name || p.release?.tag_name || ''}` + said(p.release?.body); url = p.release?.html_url || `${home}/releases`; threadId = `${repo}:releases`; break;
    case 'CreateEvent': case 'DeleteEvent': if (p.ref_type === 'repository') text = `[created] ${repo}`; else text = `[${ev.type === 'CreateEvent' ? 'created' : 'deleted'} ${p.ref_type || 'ref'}] ${p.ref || ''}`; threadId = `${repo}:refs`; break;
    case 'MemberEvent': text = `[member ${p.action}] ${p.member?.login || ''}`; threadId = `${repo}:members`; break;
    case 'PublicEvent': text = `[public] ${repo} was made public`; threadId = `${repo}:refs`; break;
    case 'GollumEvent': text = `[wiki] ${who} edited ${(p.pages || []).map(g => g.title).filter(Boolean).join(', ') || 'the wiki'}`; url = p.pages?.[0]?.html_url || `${home}/wiki`; threadId = `${repo}:wiki`; break;
    default: if (!ev.type) return null; text = `[${ev.type.replace(/Event$/, '')}] ${who}${ref ? ' on ' + ref : ''}`;
  }
  return { sourceId: `ev:${ev.id}`, threadId: threadId || `${repo}:other`, author: who, authorName: who, sourceTime: new Date(ev.created_at).toISOString(), direction: 'incoming', isGroup: true,
    kind: 'text', text: text.trim(), chatName: repo, origin: history ? 'history' : undefined, url };
}

/** GitHub's activity list leaves the title out of some pull request entries: one GET to the API itself fills it in, once per pull request and pass. */
async function fillTitle(tok, api, ev, titles) {
  const pr = ev.payload?.pull_request, u = pr?.url;
  if (!pr || pr.title || typeof u !== 'string' || !u.startsWith(api + '/')) return;
  if (!titles.has(u)) { const r = await gh(tok, u).catch(() => null); titles.set(u, r?.ok ? await r.json().catch(() => null) : null); }
  const full = titles.get(u); if (full) Object.assign(pr, { title: full.title, html_url: pr.html_url || full.html_url, body: pr.body ?? full.body, merged: pr.merged ?? full.merged });
}

/** Everything new in one repository, oldest first. GitHub's list is not strictly in order and its ids do not only grow, so what
 *  was already read is remembered by id, not by position. Entries from before the first run's window are never sent. */
async function readRepo(tok, api, repo, st, skip, first) {
  const seen = new Set(st.seen || []), floor = Date.parse(st.floor || new Date(Date.now() - FIRST_S * 1000).toISOString());
  const fresh = [], titles = new Map(); let etag = st.etag, pollS = 60;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await gh(tok, `${api}/repos/${repo}/events?per_page=${PER_PAGE}&page=${page}`, page === 1 && st.etag ? { 'if-none-match': st.etag } : {});
    if (page === 1) { const p = r.headers.get('x-poll-interval'); pollS = p === null ? 60 : Math.max(0, Number(p) || 0); etag = r.headers.get('etag') || etag; }
    if (r.status === 304) break;
    if (r.status === 401) throw fail('github did not accept the token (http 401)', 'needs_login');
    if (r.status === 403 || r.status === 404) throw fail(`github would not show ${repo} (http ${r.status}): a private repository needs a token that can read it`, 'needs_login');
    if (!r.ok) throw fail(`github activity for ${repo}: http ${r.status}`);
    const list = await r.json(); if (!Array.isArray(list)) break;
    let unseen = 0;
    for (const ev of list) { if (!ev?.id || !ev.created_at || seen.has(String(ev.id))) continue; seen.add(String(ev.id)); unseen++; if (Date.parse(ev.created_at) >= floor) fresh.push(ev); }
    if (list.length < PER_PAGE || (!first && !unseen)) break;   // after the first run, a page with nothing new means the rest is known too
  }
  const items = [];
  for (const ev of fresh.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (skip.has(String(ev.actor?.login || '').toLowerCase())) continue;
    ev.repo = { ...ev.repo, name: ev.repo?.name || repo }; await fillTitle(tok, api, ev, titles);
    const it = toItem(ev, webBase(api), first); if (it) items.push(it);
  }
  return { items, etag, pollS, seen: [...seen].slice(-1000), floor: new Date(floor).toISOString() };   // GitHub keeps about 300 entries
}

async function pass() {
  const list = repos(); if (!list.length) { await send([], 'needs_login'); console.error('no repository named: put owner/name in the file "repos"'); return; }
  const tok = token(), api = apiBase(), state = loadState(), skip = skipped(); state.repos ||= {};
  await send([], state.status || 'ok');
  let worst = 'ok', sent = 0;
  for (const repo of list) {
    const st = state.repos[repo] ||= {};
    if (Date.now() < (st.pollAfter || 0)) { if (st.status && st.status !== 'ok') worst = st.status; continue; }   // GitHub said when to come back
    try {
      const got = await readRepo(tok, api, repo, st, skip, !st.started);
      for (let i = 0; i < got.items.length; i += 200) await send(got.items.slice(i, i + 200));
      // Only now, with the items accepted by the core, remember the place.
      Object.assign(st, { etag: got.etag, seen: got.seen, floor: got.floor, started: true, pollAfter: Date.now() + got.pollS * 1000, status: 'ok' }); sent += got.items.length;
    } catch (e) {
      st.status = e.status || 'error'; worst = st.status; console.error(`${repo}: ${e.message}`);
      st.pollAfter = Date.now() + (e.status === 'rate_limited' ? Math.min(3600, e.waitS) : e.status === 'needs_login' ? 600 : 60) * 1000;
    }
    saveState(state);
  }
  state.status = worst; saveState(state);
  if (sent) console.log(`pass done: sent ${sent}`);
  await send([], worst);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await send([], e.status || 'error').catch(() => {}); }
    if (ONCE) break;
    await sleep(REST_S() * 1000);
  }
}
