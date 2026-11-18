// The calendar extractor against a stand-in calendar server and a stand-in core. No real calendar, no real events.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseIcs, zonedToUtc, resolveZone, readCalendars, changes } from './main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), DAY_MS = 86400_000;
const listen = handler => new Promise(ok => { const s = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => handler(req, res, b)); }); s.listen(0, '127.0.0.1', () => ok(s)); });
const ymd = days => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '');       // a date some days from now, as iCalendar writes it
const label = days => { const d = new Date(Date.now() + days * DAY_MS), p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}${d.getUTCFullYear() === new Date().getUTCFullYear() ? '' : ' ' + d.getUTCFullYear()}`; };
const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//made up//test//EN', 'X-WR-CALNAME:Name inside the file',
  'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE',
  ...events.flatMap(e => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');

const budget = (from, to, extra = []) => ['UID:budget-1@example.invalid', `DTSTAMP:${ymd(0)}T000000Z`, `LAST-MODIFIED:${ymd(-1)}T080000Z`, `DTSTART:${ymd(3)}T${from}00Z`, `DTEND:${ymd(3)}T${to}00Z`, 'SUMMARY:Budget review',
  'LOCATION:Room 4\\, second floor', 'DESCRIPTION:Bring the numbers\\; all of them.\\nSecond line that is long enough to be fol', ' ded across two lines.',
  'ORGANIZER;CN=Dana Example:mailto:Dana@Example.invalid', 'ATTENDEE;CN=Sam Sample;PARTSTAT=ACCEPTED:mailto:sam@example.invalid', 'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:me@example.invalid',
  'ATTENDEE;PARTSTAT=DECLINED:mailto:pat@example.invalid', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:This is a reminder, not the event', 'TRIGGER:-PT10M', 'END:VALARM', ...extra];
const closed = note => ['UID:closed-1@example.invalid', `DTSTAMP:${ymd(0)}T${note ? '0101' : '0000'}00Z`, `DTSTART;VALUE=DATE:${ymd(5)}`, `DTEND;VALUE=DATE:${ymd(6)}`, 'SUMMARY:Office closed', ...(note ? [`DESCRIPTION:${note}`] : [])];
const past = ['UID:past-1@example.invalid', `DTSTART:${ymd(-2)}T090000Z`, `DTEND:${ymd(-2)}T100000Z`, 'SUMMARY:Already over'];
const weekly = ['UID:weekly-1@example.invalid', 'DTSTART;TZID=Europe/Amsterdam:20200107T100000', 'DTEND;TZID=Europe/Amsterdam:20200107T103000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', 'SUMMARY:Team sync'];
const finished = ['UID:finished-1@example.invalid', 'DTSTART:20200107T100000Z', 'DTEND:20200107T103000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:A series that ended long ago'];
const newYork = place => ['UID:ny-1@example.invalid', `DTSTART;TZID=America/New_York:${ymd(4)}T090000`, `DTEND;TZID=America/New_York:${ymd(4)}T093000`, 'SUMMARY:Call with the made-up office', ...(place ? [`LOCATION:${place}`] : [])];
const nowhere = ['UID:nowhere-1@example.invalid', `DTSTART;TZID=Made Up/Nowhere:${ymd(4)}T100000`, 'DURATION:PT45M', 'SUMMARY:Unknown zone'];
const gone = ['UID:gone-1@example.invalid', `DTSTART:${ymd(6)}T120000Z`, `DTEND:${ymd(6)}T130000Z`, 'SUMMARY:Cancelled before it was ever seen', 'STATUS:CANCELLED'];
const lunch = ['UID:lunch-1@example.invalid', `DTSTART:${ymd(2)}T120000Z`, `DTEND:${ymd(2)}T130000Z`, 'SUMMARY:Lunch', 'URL:https://example.invalid/events/lunch'];

test('sends new, changed, cancelled and removed events once each; first run is history; only ever GETs; never prints an address', async () => {
  const requests = [], got = []; let body = ics(budget('1300', '1400'), closed(), past, weekly, finished, newYork(), nowhere, gone), printed = '';
  const SECRET = 'secret-token-abc123', OTHER = 'other-secret-xyz789';
  const server = await listen((req, res) => {
    requests.push({ method: req.method, url: req.url, inm: req.headers['if-none-match'] });
    if (req.url !== `/${SECRET}/basic.ics`) { res.writeHead(500); return res.end('nope'); }
    const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', etag }); res.end(body);
  });
  const core = await listen((req, res, b) => { assert.equal(req.url, '/ingest/events'); assert.equal(req.headers.authorization, 'Bearer ingest'); const j = JSON.parse(b); assert.equal(j.source, 'calendar'); got.push(j);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j.events.length, new: j.events.length })); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-calendar-')), base = `http://127.0.0.1:${server.address().port}`;
  const run = () => new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe',
    env: { PATH: process.env.PATH, TZ: 'UTC', CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data } });
    let err = '', out = ''; c.stderr.on('data', d => err += d); c.stdout.on('data', d => out += d); c.on('exit', code => { printed += err + out; ok({ code, err, out }); }); });
  const items = () => got.flatMap(j => j.events), by = t => items().find(e => e.text.includes(t));
  try {
    let r = await run(); assert.equal(r.code, 0, r.err); assert.equal(got.at(-1).status, 'needs_login', 'no calendars yet: says so'); assert.deepEqual(requests, []);
    fs.writeFileSync(path.join(data, 'calendars.txt'), `# my made-up calendars\n\nWork = ${base}/${SECRET}/basic.ics\n  Broken = ${base}/${OTHER}/broken.ics\n`); got.length = 0;

    r = await run(); assert.equal(r.code, 0);
    assert.equal(items().length, 5, JSON.stringify(items().map(e => e.text)));
    assert.ok(items().every(e => e.origin === 'history'), 'the first read of a calendar is marked as history');
    const first = by('Budget review');
    assert.equal(first.text, `Invitation: Budget review, ${label(3)} 13:00–14:00, Room 4, second floor, from Dana Example. Invited: 3 (1 accepted, 1 declined).\n\nBring the numbers; all of them.\nSecond line that is long enough to be folded across two lines.`);
    assert.deepEqual([first.threadId, first.author, first.authorName, first.direction, first.isGroup, first.kind, first.chatName, first.url], ['budget-1@example.invalid', 'dana@example.invalid', 'Dana Example', 'incoming', true, 'text', 'Work', undefined]);
    assert.equal(first.sourceTime, new Date(Date.now() - DAY_MS).toISOString().slice(0, 10) + 'T08:00:00.000Z'); assert.match(first.sourceId, /^budget-1@example\.invalid:[0-9a-f]{12}$/);
    assert.equal(by('Office closed').text, `Event: Office closed, ${label(5)} (all day).`); assert.equal(by('Office closed').authorName, 'Work');
    assert.match(by('Team sync').text, /^Event: Team sync, Tue 7 Jan 2020 09:00–09:30, repeats every 2 weeks\.$/, 'a repeating event is one item, with the Amsterdam time turned into this machine\'s');
    assert.match(by('made-up office').text, new RegExp(`${label(4)} 1[34]:00–1[34]:30`), 'New York 09:00 is 13:00 or 14:00 UTC'); assert.match(by('Unknown zone').text, new RegExp(`${label(4)} 10:00–10:45`), 'an unknown zone falls back to local time');
    assert.ok(!by('Already over') && !by('ended long ago') && !by('before it was ever seen') && !by('reminder'));
    assert.match(r.err, /^Broken: the server answered 500\n$/, 'one calendar failing is reported by name and does not stop the other'); assert.equal(got.at(-1).status, 'ok');

    got.length = 0; requests.length = 0; r = await run(); assert.deepEqual(items(), [], 'nothing changed: nothing sent');
    assert.match(requests.find(q => q.url.includes(SECRET)).inm, /^"[0-9a-f]{40}"$/, 'asks only whether the calendar changed');

    body = ics(budget('1400', '1500', ['SEQUENCE:1']), closed('A note was added, which does not matter'), past, weekly, finished, newYork(), nowhere, gone, lunch);
    got.length = 0; r = await run(); assert.deepEqual(items().map(e => e.text.split('\n')[0]).sort(), [`Event: Lunch, ${label(2)} 12:00–13:00.`,
      `Invitation: Budget review, ${label(3)} 14:00–15:00, Room 4, second floor, from Dana Example. Changed: time moved from 13:00. Invited: 3 (1 accepted, 1 declined).`]);
    assert.ok(items().every(e => e.origin === undefined)); assert.equal(by('Budget').threadId, first.threadId); assert.notEqual(by('Budget').sourceId, first.sourceId); assert.equal(by('Lunch').url, 'https://example.invalid/events/lunch');

    body = ics(budget('1400', '1500', ['SEQUENCE:2', 'STATUS:CANCELLED']), closed(), past, weekly, finished, newYork('Room 9'), nowhere, gone, lunch);
    got.length = 0; r = await run(); assert.deepEqual(items().map(e => e.text).sort(), [`Cancelled: Budget review, ${label(3)} 14:00–15:00, Room 4, second floor, from Dana Example.`,
      by('made-up office').text]); assert.match(by('made-up office').text, /, Room 9\. Changed: a place was added\.$/);

    body = ics(budget('1400', '1500', ['SEQUENCE:2', 'STATUS:CANCELLED']), closed(), weekly, newYork('Room 9'), nowhere);
    got.length = 0; r = await run(); assert.deepEqual(items().map(e => [e.text, e.sourceId, e.threadId]), [[`Removed from the calendar: Lunch, ${label(2)} 12:00–13:00.`, 'lunch-1@example.invalid:removed', 'lunch-1@example.invalid']]);
    got.length = 0; r = await run(); assert.deepEqual(items(), [], 'and again nothing'); assert.ok(got.length >= 1, 'but it still reports in');

    assert.ok(requests.length >= 4); assert.deepEqual([...new Set(requests.map(q => q.method))], ['GET'], 'the calendar server is only ever asked to GET');
    const state = fs.readFileSync(path.join(data, 'state.json'), 'utf8');
    for (const secret of [SECRET, OTHER, base]) { assert.ok(!printed.includes(secret), 'an address is never printed'); assert.ok(!state.includes(secret), 'or kept in the state file'); }
    assert.ok(!JSON.stringify(got).includes(SECRET) && !JSON.stringify(got).includes(OTHER), 'or sent to the core');
    assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o777, 0o600);
  } finally { server.close(); core.close(); server.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('a calendar that cannot be reached, or an address that is not a calendar, is an error that names no address', async () => {
  const got = [], page = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>a web page, not a calendar</html>'); });
  const core = await listen((req, res, b) => { const j = JSON.parse(b); got.push(j); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"received":0,"new":0}'); });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-calendar-')), dead = await listen(() => {}), deadPort = dead.address().port; dead.close();
  fs.writeFileSync(path.join(data, 'calendars.txt'), `http://127.0.0.1:${deadPort}/private-abc/a.ics\nhttp://127.0.0.1:${page.address().port}/private-def/page\nnot an address at all private-ghi\n`);
  try {
    const r = await new Promise(ok => { const c = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--once'], { stdio: 'pipe', env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest', CLOCKWORK_EXTRACTOR_DATA: data } });
      let out = ''; c.stderr.on('data', d => out += d); c.stdout.on('data', d => out += d); c.on('exit', code => ok({ code, out })); });
    assert.equal(r.code, 0); assert.equal(got.at(-1).status, 'error', 'every calendar failed');
    assert.match(r.out, /calendar 1: could not be reached \(ECONNREFUSED\)/); assert.match(r.out, /calendar 2: its address did not give a calendar/); assert.match(r.out, /calendar 3: line 3 of calendars\.txt is not/);
    assert.doesNotMatch(r.out, /private-|127\.0\.0\.1/); assert.ok(!fs.existsSync(path.join(data, 'state.json')));
  } finally { page.close(); core.close(); page.closeAllConnections(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('the iCalendar reader copes with folding, escapes, quoted parameters, odd line ends and broken events', () => {
  const cal = parseIcs(['BEGIN:VCALENDAR', 'X-WR-CALNAME:Made\\, up', 'BEGIN:VTODO', 'UID:todo-1', 'SUMMARY:Not an event', 'END:VTODO',
    'BEGIN:VEVENT', 'UID:a-1', 'DTSTART:20261117T130000Z', 'DTEND:20261117T140000Z', 'summary;LANGUAGE=en:Semi\\; colon\\, comma \\\\ slash', 'LOCATION:Line one\\nLine two',
    'ORGANIZER;CN="Example, Dana: the one";X-THING="a;b":MAILTO:dana@example.invalid', 'ATTENDEE;PARTSTAT=TENTATIVE;CN=Sam:mailto:sam@example.invalid', 'DESCRIPTION:folded right he', '\tre', 'X-UNKNOWN;FOO=bar:whatever', 'a line with no colon', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:No UID, so dropped', 'DTSTART:20261117T130000Z', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b-1', 'DTSTART:not a date', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c-1', 'RECURRENCE-ID:20261124T130000Z', 'DTSTART:20261124T150000Z', 'DURATION:PT1H30M', 'STATUS:CANCELLED', 'END:VEVENT', 'END:VCALENDAR'].join('\n'));
  assert.equal(cal.name, 'Made, up'); assert.equal(cal.complete, true); assert.deepEqual(cal.events.map(e => e.uid), ['a-1', 'c-1']);
  const [a, c] = cal.events;
  assert.equal(a.summary, 'Semi; colon, comma \\ slash'); assert.equal(a.location, 'Line one, Line two'); assert.equal(a.description, 'folded right here');
  assert.deepEqual(a.organizer, { email: 'dana@example.invalid', name: 'Example, Dana: the one', partstat: '' }); assert.equal(a.attendees[0].partstat, 'TENTATIVE');
  assert.equal(a.start.ms, Date.UTC(2026, 10, 17, 13)); assert.equal(c.end.ms - c.start.ms, 90 * 60_000); assert.equal(c.cancelled, true); assert.equal(c.recurrenceId, '20261124T130000Z');
  assert.equal(parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261117T130000Z\r\n').complete, false, 'a download that stopped half-way is known to be incomplete');
  assert.deepEqual(parseIcs('').events, []); assert.deepEqual(parseIcs('<html>not a calendar</html>').events, []);
});

test('times in a named zone are turned into the right instant, through clock changes, and unknown zones are noticed', () => {
  const iso = (...a) => new Date(zonedToUtc(...a)).toISOString();
  assert.equal(iso(2026, 11, 17, 14, 0, 0, 'Europe/Amsterdam'), '2026-11-17T13:00:00.000Z'); assert.equal(iso(2026, 7, 1, 14, 0, 0, 'Europe/Amsterdam'), '2026-07-01T12:00:00.000Z');
  assert.equal(iso(2026, 1, 15, 9, 0, 0, 'America/New_York'), '2026-01-15T14:00:00.000Z'); assert.equal(iso(2026, 7, 15, 9, 0, 0, 'America/New_York'), '2026-07-15T13:00:00.000Z');
  assert.equal(iso(2026, 3, 29, 3, 30, 0, 'Europe/Amsterdam'), '2026-03-29T01:30:00.000Z', 'just after the clocks go forward'); assert.equal(iso(2026, 10, 25, 1, 30, 0, 'Europe/Amsterdam'), '2026-10-24T23:30:00.000Z', 'just before they go back');
  assert.equal(iso(2026, 6, 1, 12, 0, 0, 'Asia/Kolkata'), '2026-06-01T06:30:00.000Z'); assert.equal(iso(2026, 1, 1, 0, 0, 0, 'Pacific/Auckland'), '2025-12-31T11:00:00.000Z');
  assert.equal(resolveZone('W. Europe Standard Time'), 'Europe/Berlin'); assert.equal(resolveZone('/vendor.example.invalid/20260101/Europe/Berlin'), 'Europe/Berlin'); assert.equal(resolveZone('Made Up/Nowhere'), null); assert.equal(resolveZone(undefined), null);
  const ev = z => parseIcs(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:z\nDTSTART;TZID=${z}:20261117T140000\nEND:VEVENT\nEND:VCALENDAR`).events[0].start.ms;
  assert.equal(ev('"Europe/Amsterdam"'), Date.UTC(2026, 10, 17, 13)); assert.equal(ev('Eastern Standard Time'), Date.UTC(2026, 10, 17, 19)); assert.equal(ev('Made Up/Nowhere'), new Date(2026, 10, 17, 14).getTime());
});

test('the list of calendars: comments, blank lines, names, webcal, and addresses with = in them', () => {
  const list = readCalendars('# comment\n\nhttps://example.invalid/a.ics?key=abc=\nHome = webcal://example.invalid/b.ics?x=1\n  Work=https://example.invalid/c.ics\nftp://example.invalid/d.ics\n');
  assert.deepEqual(list.map(c => [c.name, c.url]), [['calendar 1', 'https://example.invalid/a.ics?key=abc='], ['Home', 'https://example.invalid/b.ics?x=1'], ['Work', 'https://example.invalid/c.ics'], ['calendar 4', null]]);
  assert.equal(new Set(list.map(c => c.key)).size, 4); assert.ok(list.every(c => /^[0-9a-f]{16}$/.test(c.key)));
});

test('an incomplete download never makes events look removed', () => {
  const cal = { name: 'c', named: true }, now = Date.UTC(2026, 10, 15), full = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:keep\nDTSTART:20261117T130000Z\nDTEND:20261117T140000Z\nSUMMARY:Keep\nEND:VEVENT\nEND:VCALENDAR';
  const seen = { events: changes(parseIcs(full), undefined, cal, now).events };
  const cut = changes(parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:other\nDTSTART:20261118T130000Z\nSUMMARY:Other'), seen, cal, now);
  assert.deepEqual(cut.items, []); assert.ok(cut.events.keep);
  assert.deepEqual(changes(parseIcs('BEGIN:VCALENDAR\nEND:VCALENDAR'), seen, cal, now).items.map(i => i.sourceId), ['keep:removed']);
  assert.deepEqual(changes(parseIcs('BEGIN:VCALENDAR\nEND:VCALENDAR'), seen, cal, Date.UTC(2026, 10, 18)).items, [], 'an event that is simply over is not "removed"');
});

test('the program only ever downloads: every request it makes to a calendar is a GET', () => {
  const src = fs.readFileSync(path.join(HERE, 'main.mjs'), 'utf8'), fetches = [...src.matchAll(/fetch\(([^,]+), \{ method: '(\w+)'/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(fetches, [["CORE + '/ingest/events'", 'POST'], ['cal.url', 'GET']]); assert.equal(src.match(/\bfetch\(/g).length, 2);
});
