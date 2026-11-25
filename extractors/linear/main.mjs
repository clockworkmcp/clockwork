// Linear extractor: reads the notifications in the user's Linear inbox through Linear's GraphQL API and posts new ones to
// Clockwork. Read-only by construction: the only thing it ever sends to Linear is the one `query` below. GraphQL uses POST
// for reads too; there is no mutation anywhere in this file, so it cannot mark as read, archive or snooze anything.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const API = process.env.CLOCKWORK_LINEAR_API || 'https://api.linear.app/graphql';
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const PACE_MS = num('CLOCKWORK_LINEAR_PACE_MS', 1500);            // pause before every Linear call
const FIRST_S = num('CLOCKWORK_LINEAR_FIRST_HOURS', 24) * 3600;   // history brought in on the first run
const REST_S = num('CLOCKWORK_LINEAR_REST_SECONDS', 120);         // pause between looks at the inbox
const PAGE = num('CLOCKWORK_LINEAR_PAGE', 50), MAX_PAGES = 6;     // notifications per call, and calls per look
const ONCE = process.argv.includes('--once');
const SOURCE = 'linear';

// Field names checked against Linear's published schema (linear/linear, packages/sdk/src/schema.graphql).
const QUERY = `query ClockworkInbox($first: Int!, $after: String) {
  viewer { id }
  notifications(first: $first, after: $after, orderBy: createdAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id type createdAt readAt
      actor { id name displayName }
      botActor { name }
      externalUserActor { name }
      ... on IssueNotification {
        issue { id identifier title url state { name } project { name } }
        team { name }
        comment { body url }
      }
      ... on ProjectNotification {
        project { id name url }
        comment { body url }
        projectUpdate { body url }
      }
    }
  }
}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json'), tokenFile = path.join(DATA, 'token');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };
/** The key: from the Keychain, handed over by Clockwork. The file is where it used to be kept. */
const readToken = () => { if (process.env.CLOCKWORK_SECRET_TOKEN) return process.env.CLOCKWORK_SECRET_TOKEN.trim(); try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; } };

let lastContact = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

/** One read from Linear. Refuses anything that is not a query. Waits out rate limits; a rejected key is thrown with `login`. */
async function linear(token, query, variables) {
  if (!/^\s*query\b/.test(query) || /\bmutation\b/i.test(query)) throw new Error('this extractor only reads: refusing to send anything but a query');
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    const r = await fetch(API, { method: 'POST', headers: { authorization: token, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    const j = await r.json().catch(() => null), codes = (j?.errors || []).map(e => e?.extensions?.code);
    if (r.status === 429 || codes.includes('RATELIMITED')) {
      if (attempt >= 4) throw new Error('linear: still rate limited, giving up until the next look');
      const ra = r.headers.get('retry-after'); await sleep((ra === null ? 60 * (attempt + 1) : Math.max(1, Number(ra) || 1)) * 1000); await heartbeat(); continue;
    }
    if (r.status === 401 || r.status === 403 || codes.includes('AUTHENTICATION_ERROR')) throw Object.assign(new Error('linear: the API key was not accepted'), { login: true });
    if (!j?.data?.notifications) throw new Error(`linear: ${j?.errors?.[0]?.message || `http ${r.status}`}`);
    return j.data;
  }
}

const words = type => String(type || 'notification').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();   // issueNewComment -> issue new comment
export function toItem(n, me, history) {
  const issue = n.issue, project = n.project, body = n.comment?.body || n.projectUpdate?.body || '';
  const who = n.actor ? (n.actor.displayName || n.actor.name) : n.botActor?.name || n.externalUserActor?.name || 'Linear';
  const about = [n.team?.name && `team ${n.team.name}`, issue?.project?.name && `project ${issue.project.name}`, issue?.state?.name && `status ${issue.state.name}`].filter(Boolean).join(', ');
  const text = `[${words(n.type)}] ${body || issue?.title || project?.name || ''}`.trim() + (about ? `\n(${about})` : '');
  return { sourceId: n.id, threadId: issue?.identifier || (project?.id && `project:${project.id}`) || n.id,
    author: n.actor?.id || (n.botActor?.name && `bot:${n.botActor.name}`) || (n.externalUserActor?.name && `external:${n.externalUserActor.name}`) || 'linear', authorName: who,
    sourceTime: new Date(n.createdAt).toISOString(), direction: n.actor?.id && n.actor.id === me ? 'outgoing' : 'incoming', isGroup: true, kind: 'text',
    text: text.slice(0, 8000), chatName: issue ? `${issue.identifier} ${issue.title}` : project?.name, origin: history ? 'history' : undefined,
    url: n.comment?.url || n.projectUpdate?.url || issue?.url || project?.url };
}

async function pass() {
  const token = readToken();
  if (!token) { await send([], 'needs_login'); return; }
  const state = loadState(), first = !state.last, since = first ? Date.now() - FIRST_S * 1000 : Date.parse(state.last), seen = new Set(state.seen || []);
  const fresh = []; let me, after;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {                    // newest first; stop at the first one already seen
      const d = await linear(token, QUERY, { first: PAGE, after }), nodes = d.notifications.nodes || []; me = d.viewer?.id;
      fresh.push(...nodes.filter(n => Date.parse(n.createdAt) >= since && !seen.has(n.id)));
      if (!d.notifications.pageInfo?.hasNextPage || nodes.some(n => Date.parse(n.createdAt) < since)) break;
      after = d.notifications.pageInfo.endCursor;
    }
  } catch (e) { await send([], e.login ? 'needs_login' : 'error'); throw e; }
  await send([]);
  const items = fresh.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map(n => toItem(n, me, first));
  let added = 0;
  for (let i = 0; i < items.length; i += 200) added += (await send(items.slice(i, i + 200))).new || 0;
  const newest = fresh.length ? fresh.at(-1).createdAt : new Date(since).toISOString();
  saveState({ last: newest, seen: [...seen, ...fresh.map(n => n.id)].slice(-500) });   // only after the core has the items
  if (items.length) console.log(`pass done: sent ${items.length}, ${added} new`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
