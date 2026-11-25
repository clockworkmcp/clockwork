// GitHub repository extractor: what happens on the repositories you name, read through GitHub's REST API and posted to Clockwork.
// Issues, pull requests, comments, commits, stars and forks are asked for directly, so they arrive within a pass. Releases,
// reviews and new branches come from the repository's activity list, which GitHub says can run minutes to hours late.
// Read-only by construction: every call to GitHub is a GET.
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
const REST_S = () => num('CLOCKWORK_GITHUB_REST_SECONDS', token() ? 60 : 900);   // about six calls a pass and repository

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

const item = (repo, sourceId, threadId, who, at, text, url, history) => ({ sourceId, threadId, author: who || 'github', authorName: who || 'GitHub', sourceTime: new Date(at).toISOString(),
  direction: 'incoming', isGroup: true, kind: 'text', text: text.trim(), chatName: repo, origin: history ? 'history' : undefined, url });
const said = (who, body) => cut(body) ? `\n\n${who}: ${cut(body)}` : '';
const refuse = (r, repo, what) => {
  if (r.status === 401) throw fail('github did not accept the token (http 401)', 'needs_login');
  if (r.status === 403 || r.status === 404) throw fail(`github would not show ${repo} (http ${r.status}): a private repository needs a token that can read it`, 'needs_login');
  if (!r.ok) throw fail(`github ${what} for ${repo}: http ${r.status}`);
};
/** Every page of a list, up to MAX_PAGES. */
async function pages(tok, repo, what, url, headers) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await gh(tok, `${url}${url.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`, headers); refuse(r, repo, what);
    const list = await r.json(); if (!Array.isArray(list)) break; out.push(...list); if (list.length < PER_PAGE) break;
  }
  return out;
}

/** Issues, pull requests, comments, stars and forks, asked for directly, so they arrive within a pass of happening.
 *  Ids are stable, so anything read twice (the passes overlap on purpose) is stored once by the core. */
export async function readDirect(tok, api, repo, st, skip, first, floor) {
  const web = webBase(api), home = `${web}/${repo}`, base = `${api}/repos/${repo}`, out = [];
  const since = new Date(st.since ? Date.parse(st.since) - 120_000 : floor).toISOString(), now = new Date().toISOString(), q = `since=${encodeURIComponent(since)}`;
  const after = t => t && Date.parse(t) >= Date.parse(since) && Date.parse(t) >= floor, ok = who => !skip.has(String(who || '').toLowerCase());
  const add = (who, ...rest) => { if (ok(who)) out.push(item(repo, ...rest, first)); };
  const r = await gh(tok, base); refuse(r, repo, 'repository'); const info = await r.json();

  // Issues and pull requests that changed: opened, closed, merged, reopened.
  const titles = new Map(), known = st.issues || {}, isPr = n => !!titles.get(n)?.pr;
  for (const i of await pages(tok, repo, 'issues', `${base}/issues?state=all&sort=updated&direction=asc&${q}`)) {
    if (!i?.number) continue; const pr = !!i.pull_request, kind = pr ? 'pull request' : 'issue', ref = `#${i.number} ${i.title || ''}`.trim(), thread = `${repo}#${i.number}`, url = i.html_url || `${home}/${pr ? 'pull' : 'issues'}/${i.number}`;
    titles.set(i.number, { title: i.title, pr });
    if (after(i.created_at)) add(i.user?.login, `${kind}:${i.id}:opened`, thread, i.user?.login, i.created_at, `[${kind} opened] ${ref}` + said(i.user?.login, i.body), url);
    const merged = i.pull_request?.merged_at, by = i.closed_by?.login || null;   // the list does not say who closed it
    if (i.state === 'closed' && after(i.closed_at)) add(i.closed_by?.login, `${kind}:${i.id}:closed:${i.closed_at}`, thread, by, i.closed_at, `[${kind} ${merged ? 'merged' : 'closed'}] ${ref}`, url);
    if (i.state === 'open' && known[i.number] === 'closed') add(null, `${kind}:${i.id}:reopened:${i.updated_at}`, thread, null, i.updated_at, `[${kind} reopened] ${ref}`, url);
    known[i.number] = i.state;
  }
  // Comments on issues and pull requests, then comments on lines of a pull request.
  const numberOf = u => Number(/\/(?:issues|pulls)\/(\d+)$/.exec(u || '')?.[1]) || 0, ref = n => `#${n}${titles.get(n)?.title ? ' ' + titles.get(n).title : ''}`;
  for (const c of await pages(tok, repo, 'comments', `${base}/issues/comments?sort=created&direction=asc&${q}`)) {
    const n = numberOf(c.issue_url), pr = isPr(n) || /\/pull\/\d+/.test(c.html_url || ''); if (!c?.id || !after(c.created_at)) continue;
    add(c.user?.login, `comment:${c.id}`, `${repo}#${n}`, c.user?.login, c.created_at, `[comment] on ${pr ? 'pull request' : 'issue'} ${ref(n)}` + said(c.user?.login, c.body), c.html_url || home);
  }
  for (const c of await pages(tok, repo, 'review comments', `${base}/pulls/comments?sort=created&direction=asc&${q}`)) {
    const n = numberOf(c.pull_request_url); if (!c?.id || !after(c.created_at)) continue;
    add(c.user?.login, `review-comment:${c.id}`, `${repo}#${n}`, c.user?.login, c.created_at, `[review comment] on pull request ${ref(n)}${c.path ? ` (${c.path})` : ''}` + said(c.user?.login, c.body), c.html_url || home);
  }
  // Commits on the main branch, each with the first line of its message.
  for (const c of await pages(tok, repo, 'commits', `${base}/commits?${q}`)) {
    const at = c.commit?.committer?.date || c.commit?.author?.date, who = c.author?.login || c.commit?.author?.name, branch = info.default_branch || 'main'; if (!c?.sha || !after(at)) continue;
    add(c.author?.login, `commit:${c.sha}`, `${repo}:push:${branch}`, who, at, `[commit] ${String(c.commit?.message || '').split('\n')[0].slice(0, 200)}`, c.html_url || `${home}/commit/${c.sha}`);
  }
  // Stars and forks: only looked at when the repository's own count changed. A star carries the new total.
  const stars = Number(info.stargazers_count) || 0, forks = Number(info.forks_count) || 0;
  if (stars !== st.stars && stars > 0) {
    const last = Math.max(1, Math.ceil(stars / PER_PAGE));
    for (const page of last > 1 ? [last - 1, last] : [last]) {
      const sr = await gh(tok, `${base}/stargazers?per_page=${PER_PAGE}&page=${page}`, { accept: 'application/vnd.github.star+json' }); refuse(sr, repo, 'stars');
      for (const g of await sr.json().catch(() => [])) if (g?.user?.login && after(g.starred_at))
        add(g.user.login, `star:${g.user.login}:${g.starred_at}`, `${repo}:stars`, g.user.login, g.starred_at, `[star] ${g.user.login} starred ${repo} (${stars} in all)`, g.user.html_url || `${web}/${g.user.login}`);
    }
  }
  if (forks !== st.forks && forks > 0) {
    const fr = await gh(tok, `${base}/forks?sort=newest&per_page=30`); refuse(fr, repo, 'forks');
    for (const f of await fr.json().catch(() => [])) if (f?.id && after(f.created_at))
      add(f.owner?.login, `fork:${f.id}`, `${repo}:forks`, f.owner?.login, f.created_at, `[fork] ${f.owner?.login} forked ${repo} to ${f.full_name}`, f.html_url || home);
  }
  const keep = Object.fromEntries(Object.entries(known).slice(-2000));
  return { items: out.sort((a, b) => Date.parse(a.sourceTime) - Date.parse(b.sourceTime)), since: now, stars, forks, issues: keep };
}

// What readDirect already brings; the activity list is only used for the rest (releases, reviews, new branches).
const DIRECT = new Set(['IssuesEvent', 'IssueCommentEvent', 'PullRequestEvent', 'PullRequestReviewCommentEvent', 'WatchEvent', 'ForkEvent', 'PushEvent']);

/** The rest, from GitHub's activity list, oldest first. That list can run minutes to hours late, is not strictly in order and its
 *  ids do not only grow, so what was already read is remembered by id, not by position. */
async function readEvents(tok, api, repo, st, skip, first, floor) {
  const seen = new Set(st.seen || []), fresh = [], titles = new Map(); let etag = st.etag, pollS = 60;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await gh(tok, `${api}/repos/${repo}/events?per_page=${PER_PAGE}&page=${page}`, page === 1 && st.etag ? { 'if-none-match': st.etag } : {});
    if (page === 1) { const p = r.headers.get('x-poll-interval'); pollS = p === null ? 60 : Math.max(0, Number(p) || 0); etag = r.headers.get('etag') || etag; }
    if (r.status === 304) break;
    refuse(r, repo, 'activity');
    const list = await r.json(); if (!Array.isArray(list)) break;
    let unseen = 0;
    for (const ev of list) { if (!ev?.id || !ev.created_at || seen.has(String(ev.id))) continue; seen.add(String(ev.id)); unseen++; if (Date.parse(ev.created_at) >= floor && !DIRECT.has(ev.type)) fresh.push(ev); }
    if (list.length < PER_PAGE || (!first && !unseen)) break;   // after the first run, a page with nothing new means the rest is known too
  }
  const items = [];
  for (const ev of fresh.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (skip.has(String(ev.actor?.login || '').toLowerCase())) continue;
    ev.repo = { ...ev.repo, name: ev.repo?.name || repo }; await fillTitle(tok, api, ev, titles);
    const it = toItem(ev, webBase(api), first); if (it) items.push(it);
  }
  return { items, etag, pollS, seen: [...seen].slice(-1000) };   // GitHub keeps about 300 entries
}

/** Everything new in one repository. Nothing from before the first run's window is ever sent. */
async function readRepo(tok, api, repo, st, skip, first) {
  const floor = Date.parse(st.floor || new Date(Date.now() - FIRST_S * 1000).toISOString());
  const d = await readDirect(tok, api, repo, st, skip, first, floor), e = await readEvents(tok, api, repo, st, skip, first, floor);
  return { items: [...d.items, ...e.items].sort((a, b) => Date.parse(a.sourceTime) - Date.parse(b.sourceTime)), keep: { since: d.since, stars: d.stars, forks: d.forks, issues: d.issues, etag: e.etag, seen: e.seen, floor: new Date(floor).toISOString() }, pollS: e.pollS };
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
      Object.assign(st, { ...got.keep, started: true, pollAfter: Date.now() + got.pollS * 1000, status: 'ok' }); sent += got.items.length;
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
    let reached = true;
    try { await pass(); } catch (e) { console.error('failed:', e.message); reached = await send([], e.status || 'error').then(() => true, () => false); }
    if (ONCE) break;
    await sleep((reached ? REST_S() : 20) * 1000);   // Clockwork itself not answering (it is still starting): try again soon
  }
}
