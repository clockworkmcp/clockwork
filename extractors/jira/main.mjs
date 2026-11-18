// Jira extractor: finds the Jira Cloud issues that involve the user and were updated lately, and posts each update to
// Clockwork as one item. Read-only by construction: every call to Jira is a GET (who am I, search, latest comment).
// It never transitions, comments, assigns, watches or edits.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const API_OVERRIDE = (process.env.CLOCKWORK_JIRA_API || '').replace(/\/$/, '');   // for tests: a stand-in for the Jira site
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_JIRA_PACE_MS', 1000);              // pause before every Jira call
const FIRST_MIN = num('CLOCKWORK_JIRA_FIRST_HOURS', 24) * 60;     // history brought in on the first run
const REST_S = num('CLOCKWORK_JIRA_REST_SECONDS', 120);           // pause between searches
const PAGE = num('CLOCKWORK_JIRA_PAGE', 50), MAX_PAGES = 10;      // issues per call, and calls per search
const OVERLAP_MIN = 5, MAX_MIN = 7 * 1440, SLOP_MS = 5000;        // look a little further back than needed: Jira's search can lag
const ONCE = process.argv.includes('--once');
const SOURCE = 'jira';
const DEFAULT_JQL = 'assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json'), loginFile = path.join(DATA, 'login.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
/** The saved login, or null with a reason when it is missing or unusable. The token is never printed. */
function readLogin() {
  let j; try { j = JSON.parse(fs.readFileSync(loginFile, 'utf8')); } catch (e) { return { problem: e.code === 'ENOENT' ? null : 'login.json is not valid JSON' }; }
  let site; try { site = new URL(String(j.site)); } catch { return { problem: 'login.json: "site" must be an address like https://yourname.atlassian.net' }; }
  if (site.protocol !== 'https:') return { problem: 'login.json: "site" must start with https://' };
  if (!j.email || !j.apiToken) return { problem: 'login.json: "email" and "apiToken" are both needed' };
  if (j.cloudId !== undefined && !/^[A-Za-z0-9-]+$/.test(String(j.cloudId))) return { problem: 'login.json: "cloudId" does not look like a cloud id' };
  const api = API_OVERRIDE || (j.cloudId ? `https://api.atlassian.com/ex/jira/${j.cloudId}` : site.origin);   // tokens with scopes go through api.atlassian.com
  return { site: site.origin, host: site.host, api, auth: 'Basic ' + Buffer.from(`${j.email}:${j.apiToken}`).toString('base64'), jql: typeof j.jql === 'string' && j.jql.trim() ? j.jql.trim() : DEFAULT_JQL };
}

let lastContact = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

/** One read from Jira: always a GET. Waits out rate limits; rejected credentials are thrown with `login`. */
async function jira(login, pathname, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    const r = await fetch(`${login.api}${pathname}${qs ? '?' + qs : ''}`, { method: 'GET', headers: { authorization: login.auth, accept: 'application/json' } });
    if (r.status === 429) {
      if (attempt >= 4) throw new Error(`jira ${pathname}: still rate limited, giving up until the next search`);
      const ra = r.headers.get('retry-after'); await sleep((ra === null ? 30 * (attempt + 1) : Math.max(1, Number(ra) || 1)) * 1000); await heartbeat(); continue;
    }
    if (r.status === 401) throw Object.assign(new Error('jira: the email and API token were not accepted'), { login: true });
    if (!r.ok) throw Object.assign(new Error(`jira ${pathname}: http ${r.status}`), { http: r.status });
    return r.json();
  }
}

/** Atlassian Document Format (the JSON Jira stores comments in) to plain text. */
export function adfText(node) {
  const kids = (n, sep = '') => (n.content || []).map(walk).join(sep);
  function walk(n) {
    if (!n || typeof n !== 'object') return '';
    const a = n.attrs || {};
    switch (n.type) {
      case 'text': { const href = (n.marks || []).find(m => m.type === 'link')?.attrs?.href, t = n.text || ''; return href && href !== t ? `${t} (${href})` : t; }
      case 'hardBreak': return '\n';
      case 'mention': return a.text || '@' + (a.id || 'someone');
      case 'emoji': return a.text || a.shortName || '';
      case 'status': return a.text ? `[${a.text}]` : '';
      case 'date': return Number(a.timestamp) ? new Date(Number(a.timestamp)).toISOString().slice(0, 10) : '';
      case 'inlineCard': case 'blockCard': case 'embedCard': return a.url || '';
      case 'media': case 'mediaInline': return '[attachment]';
      case 'rule': return '---\n';
      case 'paragraph': case 'heading': case 'codeBlock': case 'mediaSingle': case 'mediaGroup': return kids(n) + '\n';
      case 'listItem': case 'taskItem': case 'decisionItem': return '- ' + kids(n).trim().replace(/\n/g, '\n  ') + '\n';
      case 'tableRow': return (n.content || []).map(c => walk(c).trim().replace(/\n/g, ' ')).join(' | ') + '\n';
      case 'blockquote': return kids(n).trim().replace(/^/gm, '> ') + '\n';
      default: return kids(n);                                         // doc, lists, panel, table, expand and anything new: just the text inside
    }
  }
  return walk(node).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const short = s => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > 80 ? s.slice(0, 77) + '...' : s; };
const side = (it, k) => Object.hasOwn(it, k) && typeof it[k] === 'string' && it[k] ? short(it[k]) : 'none';   // `toString` is a real field name here
const changeLine = it => `${it.field}: ${side(it, 'fromString')} -> ${side(it, 'toString')}`;

/** What happened in this update and who did it: a field change (from the change history), a new issue, or a comment. */
async function explain(login, issue, prev) {
  const f = issue.fields || {}, upd = Date.parse(f.updated), floor = prev ? Date.parse(prev) : upd - SLOP_MS;
  const hist = (issue.changelog?.histories || []).filter(h => Date.parse(h.created) > floor).sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  if (hist.length && Date.parse(hist[0].created) >= upd - SLOP_MS)
    return { actor: hist[0].author, what: 'changed', detail: [...new Set(hist.flatMap(h => h.items || []).map(changeLine))].slice(0, 10).join('; ') };
  if (Math.abs(Date.parse(f.created) - upd) <= SLOP_MS) return { actor: f.creator || f.reporter, what: 'created', detail: f.summary || '' };
  const page = await jira(login, `/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment`, { orderBy: '-created', maxResults: 1 });
  const c = (page.comments || [])[0];
  if (c && Date.parse(c.updated || c.created) >= upd - SLOP_MS) return { actor: c.updateAuthor || c.author, what: 'comment', detail: c.body ? adfText(c.body) : '' };
  return { actor: undefined, what: 'updated', detail: f.summary || '' };
}

export function toItem(login, issue, x, history) {
  const f = issue.fields || {}, status = f.status?.name, label = { comment: `Comment on ${issue.key}`, changed: `${issue.key} changed`, created: `${issue.key} created`, updated: `${issue.key} updated` }[x.what];
  return { sourceId: `${login.host}:${issue.key}:${f.updated}`, threadId: `${login.host}:${issue.key}`,
    author: x.actor?.accountId, authorName: x.actor?.displayName, sourceTime: new Date(f.updated).toISOString(), direction: 'incoming', isGroup: true, kind: 'text',
    text: `${label}${status ? ` (${status})` : ''}: ${x.detail}`.slice(0, 8000), chatName: `${issue.key} ${f.summary || ''}`.trim(), origin: history ? 'history' : undefined,
    url: `${login.site}/browse/${issue.key}` };
}

async function pass() {
  const login = readLogin();
  if (!login.auth) { if (login.problem) console.error(login.problem); await send([], 'needs_login'); return; }
  let me; try { me = await jira(login, '/rest/api/3/myself'); } catch (e) { await send([], e.login || e.http === 403 ? 'needs_login' : 'error'); throw e; }
  await send([]);
  const state = loadState(), first = !state.since, started = Date.now(); state.seen ||= {};
  const minutes = first ? FIRST_MIN : Math.min(MAX_MIN, Math.ceil((started - state.since) / 60_000) + OVERLAP_MIN);
  const jql = `(${login.jql.replace(/\s+order\s+by\s[^)]*$/i, '')}) AND updated >= -${minutes}m ORDER BY updated ASC`;
  const items = []; let token;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await jira(login, '/rest/api/3/search/jql', { jql, maxResults: PAGE, fields: 'summary,status,updated,created,creator,reporter', expand: 'changelog', nextPageToken: token });
    for (const issue of res.issues || []) {
      const updated = issue.fields?.updated; if (!issue.key || !updated || state.seen[issue.key] === updated) continue;
      const x = await explain(login, issue, state.seen[issue.key]);
      if (!(x.actor?.accountId && x.actor.accountId === me.accountId)) items.push(toItem(login, issue, x, first));   // the user's own updates are not news
      state.seen[issue.key] = updated;
    }
    token = res.nextPageToken; if (!token || res.isLast) break;
    await heartbeat();
  }
  let added = 0;
  for (let i = 0; i < items.length; i += 200) added += (await send(items.slice(i, i + 200))).new || 0;
  for (const [k, u] of Object.entries(state.seen)) if (Date.parse(u) < started - (MAX_MIN + 1440) * 60_000) delete state.seen[k];
  state.since = started; saveState(state);                            // only after the core has the items
  if (items.length) console.log(`pass done: sent ${items.length}, ${added} new`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
