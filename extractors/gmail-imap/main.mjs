// Gmail extractor that signs in with an app password: reads new mail over IMAP and posts it to Clockwork.
// Read-only twice over: the mailbox is opened with EXAMINE, which Gmail itself treats as read-only, and mail is fetched
// with BODY.PEEK, so nothing is marked as read. imap.mjs cannot send a command that changes a mailbox.
// It files items under the source "gmail" with the same ids as the `gmail` extractor (Google's API), so the two never
// store one mail twice and the local model trained on one carries over to the other. Run one of them, not both.
import fs from 'node:fs'; import path from 'node:path';
import { openImap, HOST } from './imap.mjs'; import { readMail } from './mail.mjs';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const FIXTURES = process.env.CLOCKWORK_FIXTURES || '';               // set by `clockwork check`: read sample mail from this folder, contact nobody
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const REST_S = num('CLOCKWORK_GMAIL_IMAP_REST_SECONDS', 60);         // pause between looks at the mailbox
const FIRST_MS = num('CLOCKWORK_GMAIL_IMAP_FIRST_DAYS', 3) * 86400e3; // history brought in on the first run
const MAX_PASS = 500, FETCH_AT_ONCE = 20, MAX_TEXT = 6000, SOURCE = 'gmail', ONCE = process.argv.includes('--once');
const SKIP = new Set(['DRAFT', 'SPAM', 'TRASH']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateFile = path.join(DATA, 'state.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };

/**
 * The address and app password, or `{ problem }`. Clockwork keeps them in the Keychain (or the host's secret store) and
 * hands them to this program in its environment each time it starts; this program never reads or writes them on disk.
 * Anything that is not shaped like an app password is refused and sent nowhere.
 */
export function readLogin(env = process.env) {
  const address = String(env.CLOCKWORK_SECRET_ADDRESS || '').trim().toLowerCase(), password = String(env.CLOCKWORK_SECRET_APP_PASSWORD || '').replace(/[\s-]+/g, '');
  if (!address && !password) return { problem: 'no address and app password saved yet' };
  if (!/^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/.test(address)) return { problem: 'the saved address is not an email address' };
  if (!/^[a-z]{16}$/i.test(password)) return { problem: 'what is saved does not look like a Google app password (sixteen letters). Never give Clockwork your normal Google password' };
  return { address, password };
}

async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); return r.json();
}

function parseFrom(v = '') {
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(v);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim().toLowerCase() } : { email: v.trim().toLowerCase() || undefined };
}
/** Gmail's labels as Google's API spells them, so both Gmail extractors describe a mail the same way: `\Inbox` is INBOX, a category is CATEGORY_UPDATES. */
const labelsOf = (labels = [], categories = []) => [...labels.map(l => l.startsWith('\\') ? l.slice(1).toUpperCase() : l), ...categories.map(c => 'CATEGORY_' + c.toUpperCase())];
/** Gmail's number for a message or thread, written the way Google's API writes it. */
const hex = digits => BigInt(digits).toString(16);

/** A fetched message to a Clockwork item, or null for what is not mail to read (drafts, spam, the bin). */
export function toItem(msg, { categories = [], history = false } = {}) {
  const labels = labelsOf(msg.labels, categories); if (labels.some(l => SKIP.has(l))) return null;
  const mail = readMail(msg.raw), from = parseFrom(mail.header('from')), subject = mail.header('subject'), sent = labels.includes('SENT');
  const full = `Subject: ${subject}\n\n${mail.text}`, when = Date.parse(String(msg.internalDate || '').trim().replace(/^(\d+)-(\w+)-(\d+)/, '$1 $2 $3'));
  return { sourceId: hex(msg.msgid), threadId: hex(msg.thrid), ...(history ? { origin: 'history' } : { feed: sent ? 'sent' : 'inbox' }),
    author: from.email, authorName: from.name, sourceTime: Number.isNaN(when) ? undefined : new Date(when).toISOString(), direction: sent ? 'outgoing' : 'incoming', kind: 'text', text: full.slice(0, MAX_TEXT),
    metadata: { subject, to: mail.header('to') || undefined, labels, attachments: mail.attachments || undefined, truncated: full.length > MAX_TEXT || (!mail.text && msg.size > msg.raw.length) || undefined,
      bodySource: mail.text ? (mail.fromHtml ? 'html' : 'plain') : 'none', bulk: !!mail.header('list-unsubscribe') || undefined } };
}

/** One look at the mailbox. Returns { items, state, first, gap }. The caller keeps `state` only after the core has `items`. */
export async function sync(imap, state = {}, { firstMs = FIRST_MS, maxPass = MAX_PASS, now = Date.now() } = {}) {
  let mailbox = state.mailbox, box = null;
  if (mailbox) box = await imap.examine(mailbox).catch(e => { if (imap.closed) throw e; return null; });   // refused: it was renamed (the account's language changed), so look it up again
  if (!box) { mailbox = await imap.allMail(); box = await imap.examine(mailbox); }
  if (!box.uidValidity) throw new Error('the mail server did not say which numbering this mailbox uses');
  // Message numbers (UIDs) only ever grow while UIDVALIDITY stays the same. When it changes, or on the first run, start again from recent mail.
  const known = state.mailbox === mailbox && state.uidValidity === box.uidValidity && Number.isSafeInteger(state.lastUid), ahead = (box.uidNext || 1) - 1;
  let uids, lastUid;
  if (known) {
    const found = box.uidNext && ahead <= state.lastUid ? [] : await imap.newer(state.lastUid);
    uids = found.slice(0, maxPass); lastUid = found.length > maxPass ? uids.at(-1) : Math.max(state.lastUid, ahead, uids.at(-1) ?? 0);   // a long backlog is read over several passes, oldest first
  } else { uids = (await imap.since(now - firstMs - 86400e3)).slice(-maxPass); lastUid = Math.max(ahead, uids.at(-1) ?? 0); }
  let categories = new Map();
  if (uids.length) try { categories = await imap.categories(uids[0], uids.at(-1)); } catch (e) { if (imap.closed) throw e; }   // without them a mail is still read; the model only loses one hint
  const items = [];
  for (let i = 0; i < uids.length; i += FETCH_AT_ONCE) for (const m of await imap.fetch(uids.slice(i, i + FETCH_AT_ONCE))) {
    let it; try { it = toItem(m, { categories: categories.get(m.uid), history: !known }); } catch { continue; }   // one unreadable message must never stall the mailbox
    if (it && (known || !it.sourceTime || Date.parse(it.sourceTime) >= now - firstMs)) items.push(it);
  }
  return { items, state: { mailbox, uidValidity: box.uidValidity, lastUid }, first: !known, gap: !known && state.lastUid !== undefined };
}

const LOGIN_HELP = `Gmail did not accept the app password. Check that:
  - the address you gave is the account the app password was made for;
  - 2-Step Verification is still on for the account (Google removes app passwords when it is switched off, and when the account's password changes);
  - the account is allowed to use app passwords and IMAP (a work or school account may have them switched off by its administrator).
Make a new app password at https://myaccount.google.com/apppasswords and run: clockwork connect gmail-imap --replace`;

/** With `clockwork check`: sample mail from files, so the reading code runs with no account and no network. */
async function fixturePass() {
  const files = fs.readdirSync(FIXTURES).filter(f => f.endsWith('.eml')).sort();
  const items = files.map((f, i) => toItem({ uid: i + 1, msgid: String(1000 + i), thrid: String(1000 + i), labels: ['\\Inbox'], internalDate: '01-Jan-2026 09:00:00 +0000', size: 0, raw: fs.readFileSync(path.join(FIXTURES, f)) })).filter(Boolean);
  await send(items);
}

let imap = null;                                                     // one connection, kept between passes
async function pass() {
  if (FIXTURES) return fixturePass();
  const login = readLogin();
  if (login.problem) { await send([], 'needs_login'); console.error(`not signed in: ${login.problem}. Run: clockwork connect gmail-imap --replace`); return; }
  try {
    if (!imap || imap.closed) { imap = await openImap(); await imap.login(login.address, login.password); }
    const res = await sync(imap, loadState()); let fresh = 0;
    for (let i = 0; i < res.items.length; i += 50) fresh += (await send(res.items.slice(i, i + 50))).new || 0;
    saveState(res.state);                                            // only after the core has everything, so a failed delivery is read again
    if (!res.items.length) await send([]);                           // nothing new: still tell the core this extractor is up
    else console.log(`pass done: sent ${res.items.length}, ${fresh} new${res.first ? ' (first run: recent mail as history)' : ''}${res.gap ? ' (the mailbox was renumbered; started again from recent mail)' : ''}`);
  } catch (e) {
    imap?.close(); imap = null;
    await send([], e.login ? 'needs_login' : 'error').catch(() => {});
    if (e.login) { console.error(LOGIN_HELP); return; }
    throw e;
  }
}

/** `node main.mjs verify`, run by `clockwork connect gmail-imap`: sign in once and say what will be read. */
async function verify() {
  const login = readLogin(); if (login.problem) throw new Error(login.problem);
  const c = await openImap();
  try {
    await c.login(login.address, login.password);
    const mailbox = await c.allMail(), box = await c.examine(mailbox);
    console.log(`Signed in to ${HOST}. Clockwork will read "${mailbox}"${box.exists === undefined ? '' : ` (${box.exists} messages)`} and nothing in it will be changed or marked as read.`);
    if (mailbox === 'INBOX') console.log('Your "All Mail" folder is hidden from IMAP, so only the inbox is read. To include sent and archived mail, tick "Show in IMAP" for All Mail under Gmail settings, Labels.');
  } catch (e) { throw e.login ? new Error(LOGIN_HELP) : e; } finally { await c.logout(); }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  if (process.argv[2] === 'verify') await verify().catch(e => { console.error(e.message); process.exit(1); });
  else for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); }
    if (ONCE) break;
    await sleep(REST_S * 1000);
  }
}
