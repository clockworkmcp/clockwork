// Calendar extractor: downloads the calendars the user subscribes to by iCalendar (.ics) address and posts an item
// to Clockwork for every upcoming event that is new or has changed in a way that matters (time, place, title, cancelled).
// Read-only by construction: an .ics address can only be downloaded. The only request this program ever makes to a
// calendar is a GET, so it cannot accept, decline or change anything.
// The addresses are secrets (anyone who has one can read that calendar): they are never printed and never stored
// anywhere but the user's own calendars.txt. Calendars are told apart in the state file by a hash of the address.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const INGEST = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';
const num = (k, d) => Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined ? Number(process.env[k]) : d;
const POLL_S = Math.max(1, num('CLOCKWORK_CALENDAR_POLL_MINUTES', 15)) * 60;   // how often the calendars are downloaded
const TIMEOUT_MS = num('CLOCKWORK_CALENDAR_TIMEOUT_SECONDS', 30) * 1000;
const ONCE = process.argv.includes('--once');
const SOURCE = 'calendar', DAY_MS = 86400_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const stateFile = path.join(DATA, 'state.json'), listFile = path.join(DATA, 'calendars.txt');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const saveState = s => { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile); };

let lastContact = 0;
async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + INGEST }, body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`); lastContact = Date.now(); return r.json();
}
const heartbeat = async (status = 'ok') => { if (Date.now() - lastContact > 5 * 60_000) await send([], status).catch(() => {}); };

// ---- the list of calendars ------------------------------------------------------------------------------------------
/** calendars.txt: one address per line, or `name = address`. Blank lines and lines starting with # are ignored. */
export function readCalendars(text) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim(); if (!line || line.startsWith('#')) return;
    const bare = /^(https?|webcals?):\/\//i.test(line), eq = line.indexOf('=');
    const name = !bare && eq > 0 ? line.slice(0, eq).trim() : '', url = (!bare && eq > 0 ? line.slice(eq + 1).trim() : line).replace(/^webcals?:\/\//i, 'https://');
    let ok = false; try { ok = /^https?:$/.test(new URL(url).protocol); } catch {}
    out.push({ name: name || `calendar ${out.length + 1}`, named: !!name, line: i + 1, url: ok ? url : null, key: sha(url).slice(0, 16) });
  });
  return out;
}

// ---- reading iCalendar ----------------------------------------------------------------------------------------------
const unescape = s => String(s).replace(/\\([nN,;\\])/g, (_, c) => c === 'n' || c === 'N' ? '\n' : c).trim();
/** `NAME;PARAM=value;PARAM="quoted: value":content` to its parts. Colons and semicolons inside quotes do not count. */
function parseLine(line) {
  let q = false, colon = -1; const cuts = [];
  for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') q = !q; else if (!q && ch === ';') cuts.push(i); else if (!q && ch === ':') { colon = i; break; } }
  if (colon < 0) return null;
  const edges = [...cuts, colon], params = {};
  for (let k = 0; k < cuts.length; k++) { const p = line.slice(edges[k] + 1, edges[k + 1]), eq = p.indexOf('='); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"(.*)"$/, '$1'); }
  return { name: line.slice(0, edges[0]).split('.').pop().trim().toUpperCase(), params, value: line.slice(colon + 1) };
}

// Outlook names time zones the Windows way. The common ones, so its events land at the right hour.
const WINDOWS_ZONES = { 'UTC': 'UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'Romance Standard Time': 'Europe/Paris', 'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kyiv', 'GTB Standard Time': 'Europe/Bucharest',
  'Turkey Standard Time': 'Europe/Istanbul', 'Israel Standard Time': 'Asia/Jerusalem', 'Russian Standard Time': 'Europe/Moscow', 'South Africa Standard Time': 'Africa/Johannesburg', 'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata', 'Singapore Standard Time': 'Asia/Singapore', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland', 'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Argentina/Buenos_Aires' };
const zones = new Map(), zoneFormats = new Map();
/** The name Intl knows for a TZID, or null when it knows none (the caller then reads the time as this machine's local time). */
export function resolveZone(tzid) {
  if (!tzid) return null; if (zones.has(tzid)) return zones.get(tzid);
  const parts = tzid.split('/').filter(Boolean); let found = null;       // some programs write "/vendor.example/Europe/Berlin"
  for (const z of [tzid, WINDOWS_ZONES[tzid], parts.slice(-3).join('/'), parts.slice(-2).join('/')]) { if (!z) continue; try { new Intl.DateTimeFormat('en-US', { timeZone: z }); found = z; break; } catch {} }
  zones.set(tzid, found); return found;
}
/** What a clock on the wall in `zone` shows at the instant `ms`, written as if it were UTC. */
function wallIn(ms, zone) {
  let f = zoneFormats.get(zone); if (!f) zoneFormats.set(zone, f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  const p = {}; for (const x of f.formatToParts(ms)) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
/** The instant at which a clock on the wall in `zone` shows the given time. Two steps, so the hours around a clock change come out right. */
export function zonedToUtc(y, mo, d, h, mi, s, zone) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s), first = wall - (wallIn(wall, zone) - wall);
  return wall - (wallIn(first, zone) - first);
}
/** A DTSTART-style value to { ms, allDay, key }. `key` is what is compared to see a change: for all-day and zone-less times it is the written value, so moving this machine to another time zone does not look like every event moved. */
function parseDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(String(value).trim()); if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(x => Number(x || 0));
  if (m[4] === undefined) return { ms: new Date(y, mo - 1, d).getTime(), allDay: true, key: m[0] };
  if (m[7]) { const ms = Date.UTC(y, mo - 1, d, h, mi, s); return { ms, key: ms }; }
  const zone = resolveZone(params.TZID);
  if (zone) { const ms = zonedToUtc(y, mo, d, h, mi, s, zone); return { ms, key: ms }; }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), key: m[0] };
}
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(v).trim()); if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((Number(m[2] || 0) * 7 + Number(m[3] || 0)) * DAY_MS + Number(m[4] || 0) * 3600_000 + Number(m[5] || 0) * 60_000 + Number(m[6] || 0) * 1000);
}
const person = l => ({ email: l.value.replace(/^mailto:/i, '').trim().toLowerCase(), name: l.params.CN ? unescape(l.params.CN) : '', partstat: (l.params.PARTSTAT || '').toUpperCase() });

/** The events in an iCalendar file. Tolerant: unknown properties and components are passed over, a broken event is dropped, the rest is kept. */
export function parseIcs(text) {
  const out = { name: '', complete: false, events: [] }; let ev = null, skip = 0;
  for (const raw of String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')) {       // a line that starts with a space continues the one before
    const l = parseLine(raw); if (!l) continue;
    const what = l.value.trim().toUpperCase();
    if (l.name === 'BEGIN') { if (skip || (what !== 'VCALENDAR' && what !== 'VEVENT') || (ev && what === 'VEVENT')) skip++; else if (what === 'VEVENT') ev = { attendees: [] }; continue; }
    if (l.name === 'END') { if (skip) skip--; else if (what === 'VEVENT' && ev) { const done = finish(ev); if (done) out.events.push(done); ev = null; } else if (what === 'VCALENDAR') out.complete = true; continue; }
    if (skip) continue;                                                     // inside an alarm, a time zone definition, a to-do
    if (!ev) { if (l.name === 'X-WR-CALNAME') out.name = unescape(l.value); continue; }
    switch (l.name) {
      case 'UID': ev.uid = l.value.trim(); break;
      case 'SUMMARY': ev.summary = unescape(l.value).replace(/\s+/g, ' '); break;
      case 'DESCRIPTION': ev.description = unescape(l.value); break;
      case 'LOCATION': ev.location = unescape(l.value).replace(/\s*\n\s*/g, ', '); break;
      case 'STATUS': ev.cancelled = /^CANCEL/i.test(l.value.trim()); break;
      case 'SEQUENCE': ev.sequence = Number(l.value) || 0; break;
      case 'RRULE': ev.rrule = l.value.trim().toUpperCase(); break;
      case 'RECURRENCE-ID': ev.recurrenceId = l.value.trim(); break;
      case 'URL': ev.url = l.value.trim(); break;
      case 'DTSTART': ev.start = parseDate(l.value, l.params); break;
      case 'DTEND': ev.end = parseDate(l.value, l.params); break;
      case 'DURATION': ev.duration = parseDuration(l.value); break;
      case 'LAST-MODIFIED': ev.modified = parseDate(l.value, l.params)?.ms; break;
      case 'DTSTAMP': ev.stamp = parseDate(l.value, l.params)?.ms; break;
      case 'CREATED': ev.created = parseDate(l.value, l.params)?.ms; break;
      case 'ORGANIZER': ev.organizer = person(l); break;
      case 'ATTENDEE': ev.attendees.push(person(l)); break;
    }
  }
  return out;
}
function finish(ev) {
  if (!ev.uid || !ev.start) return null;
  if (!ev.end) ev.end = ev.duration > 0 ? { ms: ev.start.ms + ev.duration, key: `${ev.start.key}+${ev.duration}` } : ev.start.allDay ? { ms: ev.start.ms + DAY_MS, allDay: true, key: '' } : { ...ev.start };
  ev.allDay = !!ev.start.allDay;
  return ev;
}

// ---- from an event to an item ---------------------------------------------------------------------------------------
const rule = r => Object.fromEntries(String(r).split(';').map(x => x.split('=')));
/** When the last occurrence ends. A repeating event is not expanded: its end is taken from UNTIL, estimated from COUNT, or never. */
function lastEnd(ev) {
  if (!ev.rrule) return ev.end.ms;
  const r = rule(ev.rrule), length = ev.end.ms - ev.start.ms;
  if (r.UNTIL) { const u = parseDate(r.UNTIL); return u ? u.ms + (u.allDay ? DAY_MS : 0) + length : Infinity; }
  if (Number(r.COUNT) > 0) return ev.start.ms + Number(r.COUNT) * (Number(r.INTERVAL) || 1) * ({ DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[r.FREQ] || 366) * DAY_MS + length;
  return Infinity;
}
function repeatText(rrule) {
  const r = rule(rrule), unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.FREQ], n = Number(r.INTERVAL) || 1, until = r.UNTIL && parseDate(r.UNTIL);
  return (!unit ? 'repeats' : n === 1 ? `repeats every ${unit}` : `repeats every ${n} ${unit}s`) + (until ? ` until ${dayText(until.ms)}` : '');
}
// Times are written in this machine's time zone, 24-hour clock: "Tue 17 Nov 14:00".
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), HM = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function dayText(ms) { const p = {}; for (const x of DAY.formatToParts(ms)) p[x.type] = x.value; return `${p.weekday} ${p.day} ${p.month}${Number(p.year) === new Date().getFullYear() ? '' : ' ' + p.year}`; }
const timeText = ms => HM.format(ms);
/** "Tue 17 Nov 14:00–15:00", "Tue 17 Nov (all day)", "Tue 17 Nov – Thu 19 Nov", "Tue 17 Nov 22:00 – Wed 18 Nov 01:00". */
function whenText(s, e, allDay) {
  if (allDay) { const last = Math.max(s, e - DAY_MS / 2); return dayText(s) === dayText(last) ? `${dayText(s)} (all day)` : `${dayText(s)} – ${dayText(last)}`; }
  if (!(e > s)) return `${dayText(s)} ${timeText(s)}`;
  return dayText(s) === dayText(e) ? `${dayText(s)} ${timeText(s)}–${timeText(e)}` : `${dayText(s)} ${timeText(s)} – ${dayText(e)} ${timeText(e)}`;
}

/** What is remembered about an event: enough to see a change that matters and to say what it was before. */
function snapshot(ev) {
  const snap = { s: ev.start.ms, e: ev.end.ms, a: ev.allDay ? 1 : 0, sk: ev.start.key, ek: ev.end.key, l: ev.location || '', t: ev.summary || '', c: ev.cancelled ? 1 : 0, r: ev.rrule || '', u: Number.isFinite(lastEnd(ev)) ? lastEnd(ev) : null };
  snap.fp = sha(JSON.stringify([snap.sk, snap.ek, snap.a, snap.l, snap.t, snap.c, snap.r])).slice(0, 12);
  return snap;
}
function describe(ev, old) {
  const who = ev.organizer && (ev.organizer.name || ev.organizer.email), bits = [ev.summary || '(no title)', whenText(ev.start.ms, ev.end.ms, ev.allDay)];
  if (ev.rrule) bits.push(repeatText(ev.rrule)); if (ev.location) bits.push(ev.location); if (who) bits.push(`from ${who}`);
  let text = `${ev.cancelled ? 'Cancelled' : ev.organizer || ev.attendees.length ? 'Invitation' : 'Event'}: ${bits.join(', ')}.`;
  const changes = [];
  if (old) {
    if (old.c && !ev.cancelled) changes.push('no longer cancelled');
    if (old.sk !== ev.start.key || old.ek !== ev.end.key || old.a !== (ev.allDay ? 1 : 0)) changes.push(`time moved from ${!old.a && !ev.allDay && dayText(old.s) === dayText(ev.start.ms) ? timeText(old.s) + (old.e - old.s !== ev.end.ms - ev.start.ms && old.e > old.s ? '–' + timeText(old.e) : '') : whenText(old.s, old.e, old.a)}`);
    if (old.l !== (ev.location || '')) changes.push(old.l ? `place was ${old.l}` : 'a place was added');
    if (old.t !== (ev.summary || '')) changes.push(`title was "${old.t}"`);
    if (old.r !== (ev.rrule || '')) changes.push(old.r ? ev.rrule ? 'how it repeats changed' : 'no longer repeats' : 'now repeats');
  }
  if (changes.length) text += ` Changed: ${changes.join('; ')}.`;
  if (ev.attendees.length && !ev.cancelled) {
    const count = k => ev.attendees.filter(a => a.partstat === k).length, parts = [['ACCEPTED', 'accepted'], ['DECLINED', 'declined'], ['TENTATIVE', 'maybe']].filter(([k]) => count(k)).map(([k, w]) => `${count(k)} ${w}`);
    text += ` Invited: ${ev.attendees.length}${parts.length ? ` (${parts.join(', ')})` : ''}.`;
  }
  if (ev.description && !ev.cancelled) text += `\n\n${ev.description.length > 600 ? ev.description.slice(0, 600) + '…' : ev.description}`;
  return text;
}

/**
 * Compare one downloaded calendar with what was seen before. Returns the items to send and what to remember.
 * `seen` is undefined the first time a calendar is read: everything upcoming is then sent as history.
 */
export function changes(parsed, seen, cal, now = Date.now()) {
  const first = !seen, known = seen?.events || {}, events = {}, items = [], chatName = cal.named ? cal.name : parsed.name || cal.name;
  const stamp = ms => new Date(Math.min(now, ms ?? now)).toISOString();
  for (const ev of parsed.events) {
    if (!(lastEnd(ev) > now)) continue;                                     // over already
    const key = ev.uid + (ev.recurrenceId ? '|' + ev.recurrenceId : ''), snap = snapshot(ev), old = known[key];
    events[key] = snap;
    if (old?.fp === snap.fp || (!old && ev.cancelled)) continue;            // nothing that matters changed; or cancelled before we ever saw it
    items.push({ sourceId: `${key}:${snap.fp}`, threadId: ev.uid, author: ev.organizer?.email || undefined, authorName: ev.organizer?.name || ev.organizer?.email || chatName,
      sourceTime: stamp(ev.modified ?? ev.stamp ?? ev.created), direction: 'incoming', isGroup: ev.attendees.length > 2, kind: 'text', text: describe(ev, old),
      chatName, url: /^https?:\/\//i.test(ev.url || '') ? ev.url : undefined, origin: first ? 'history' : undefined });
  }
  for (const [key, old] of Object.entries(known)) {
    if (events[key] || !((old.u ?? Infinity) > now)) continue;
    if (!parsed.complete) { events[key] = old; continue; }                  // a download that stopped half-way proves nothing
    if (!old.c) items.push({ sourceId: `${key}:removed`, threadId: key.split('|')[0], authorName: chatName, sourceTime: stamp(), direction: 'incoming', isGroup: false, kind: 'text',
      text: `Removed from the calendar: ${[old.t || '(no title)', whenText(old.s, old.e, old.a), old.l].filter(Boolean).join(', ')}.`, chatName });
  }
  return { items, events };
}

// ---- downloading ----------------------------------------------------------------------------------------------------
/** GET one calendar, politely: if it has not changed since last time the server says so and nothing is downloaded. Errors never contain the address. */
async function download(cal, seen) {
  const headers = { accept: 'text/calendar, text/plain;q=0.5', 'user-agent': 'clockwork-calendar' };
  if (seen?.etag) headers['if-none-match'] = seen.etag; if (seen?.modified) headers['if-modified-since'] = seen.modified;
  let r, text;
  try { r = await fetch(cal.url, { method: 'GET', headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) }); if (r.ok) text = await r.text(); }
  catch (e) { throw new Error(`could not be reached (${e.cause?.code || e.name || 'network error'})`); }
  if (r.status === 304) return null;
  if (!r.ok) throw new Error([401, 403, 404, 410].includes(r.status) ? `its address no longer works (the server answered ${r.status}): copy the current one into calendars.txt` : `the server answered ${r.status}`);
  if (!/^BEGIN:VCALENDAR/im.test(text)) throw new Error('its address did not give a calendar. Use the iCal (.ics) address, not the address of the calendar\'s web page');
  return { text, etag: r.headers.get('etag') || undefined, modified: r.headers.get('last-modified') || undefined };
}

async function pass() {
  let list = ''; try { list = fs.readFileSync(listFile, 'utf8'); } catch {}
  const cals = readCalendars(list);
  if (!cals.length) { await send([], 'needs_login'); console.log('No calendars yet. Put one iCal (.ics) address per line in calendars.txt in this extractor\'s data folder: see extractors/calendar/README.md'); return; }
  const state = loadState(); state.cals ||= {};
  for (const key of Object.keys(state.cals)) if (!cals.some(c => c.key === key)) delete state.cals[key];   // a calendar taken off the list is forgotten
  await send([]);
  let sent = 0, fresh = 0, failed = 0;
  for (const cal of cals) {
    try {
      if (!cal.url) throw new Error(`line ${cal.line} of calendars.txt is not an http(s) or webcal address`);
      const seen = state.cals[cal.key], got = await download(cal, seen);
      if (got) {
        const { items, events } = changes(parseIcs(got.text), seen, cal);
        for (let i = 0; i < items.length; i += 200) { const r = await send(items.slice(i, i + 200)); sent += Math.min(200, items.length - i); fresh += r.new || 0; }
        state.cals[cal.key] = { etag: got.etag, modified: got.modified, events }; saveState(state);   // only after the core has this calendar's items
      }
    } catch (e) { failed++; console.error(`${cal.name}: ${String(e.message).split(cal.url || '\0').join('[address]')}`); }
    await heartbeat();
  }
  if (sent || failed) console.log(`pass done: sent ${sent}, ${fresh} new${failed ? `, ${failed} calendar(s) failed` : ''}`);
  await send([], failed === cals.length ? 'error' : 'ok');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/main.mjs')) {
  for (;;) {
    try { await pass(); } catch (e) { console.error('failed:', e.message); await heartbeat('error'); }
    if (ONCE) break;
    for (const until = Date.now() + POLL_S * 1000; Date.now() < until;) { await sleep(Math.min(60_000, Math.max(0, until - Date.now()))); await heartbeat(); }
  }
}
