// The Gmail app-password extractor against a stand-in IMAP server and a stand-in core. No real Google, no real mail:
// every address, name and message here is made up.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net'; import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openImap, frame, tokens, ImapError } from './imap.mjs'; import { readMail, headerText } from './mail.mjs'; import { sync, toItem, readLogin } from './main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), DAY = 86400e3, NOW = Date.parse('2026-11-20T12:00:00Z'), ME = 'me@example.invalid', PASSWORD = 'abcdefghijklmnop';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`; };
const mail = (headers, body) => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n' + body;

const SCHOOL = mail({ From: '"Riverside School Office" <Office@Riverside-School.example>', To: ME, Subject: 'Early pickup on Friday', 'Content-Type': 'text/plain; charset=utf-8' }, 'School closes at 1pm this Friday.\r\nPlease reply by Wednesday.\r\n');
const CAFE = mail({ From: '=?UTF-8?B?Q2Fmw6kgTHVtacOocmU=?= <news@cafe-lumiere.example>', To: ME, Subject: '=?UTF-8?Q?Our_winter_menu_=E2=9D=84?=\r\n =?UTF-8?Q?_is_here?=', 'List-Unsubscribe': '<https://cafe-lumiere.example/u>', 'Content-Type': 'multipart/mixed; boundary="outer-1"' },
  ['--outer-1', 'Content-Type: multipart/alternative; boundary=inner-1', '', '--inner-1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Chestnut soup and a caf=C3=A9 cr=C3=A8me you will not =', 'forget.',
    '--inner-1', 'Content-Type: text/html; charset=utf-8', '', '<p>ignored when there is plain text</p>', '--inner-1--', '--outer-1', 'Content-Type: application/pdf; name="menu.pdf"', 'Content-Disposition: attachment; filename="menu.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--outer-1--', ''].join('\r\n'));
const HTML_ONLY = mail({ From: 'billing@power-co.example', To: `${ME}, other@example.invalid`, Subject: 'Your invoice', 'Content-Type': 'text/html; charset=iso-8859-1', 'Content-Transfer-Encoding': 'base64' },
  Buffer.from('<html><head><style>p{}</style></head><body><p>Amount due: 42 \xa3</p><p>Pay by 30 November &amp; avoid a fee.</p></body></html>', 'latin1').toString('base64'));
const REPLY = mail({ From: `Me <${ME}>`, To: 'office@riverside-school.example', Subject: 'Re: Early pickup on Friday' }, 'Their aunt will collect them.\r\n');

/** A stand-in for imap.gmail.com that speaks just the commands the extractor uses and records every command it is sent. */
async function fakeGmail(messages) {
  const st = { messages, commands: [], uidValidity: 7, allMail: '[Gmail]/All Mail', password: PASSWORD, sockets: new Set() };
  const handle = (sock, line) => {
    const m = /^(\S+) ((?:UID )?[A-Z]+) ?(.*)$/.exec(line); if (!m) return sock.write('* BAD what\r\n');
    const [, tag, verb, args] = m, ok = (t = 'done') => sock.write(`${tag} OK ${t}\r\n`);
    st.commands.push(verb === 'LOGIN' ? { verb, args: '(hidden)' } : { verb, args });
    if (verb === 'LOGIN') return args === `"${ME}" "${st.password}"` ? ok() : sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
    if (verb === 'LIST') { sock.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasChildren \\Noselect) "/" "[Gmail]"\r\n* LIST (\\All \\HasNoChildren) "/" "${st.allMail}"\r\n`); return ok(); }
    if (verb === 'EXAMINE') {
      if (args !== `"${st.allMail}"`) return sock.write(`${tag} NO [NONEXISTENT] Unknown Mailbox (Failure)\r\n`);
      sock.write(`* FLAGS (\\Answered \\Seen)\r\n* OK [PERMANENTFLAGS ()] Flags permitted.\r\n* OK [UIDVALIDITY ${st.uidValidity}] UIDs valid.\r\n* ${st.messages.length} EXISTS\r\n* OK [UIDNEXT ${Math.max(0, ...st.messages.map(x => x.uid)) + 1}] Predicted next UID.\r\n`);
      return ok('[READ-ONLY] opened (Success)');
    }
    if (verb === 'UID SEARCH') {
      let set = st.messages; const top = Math.max(0, ...set.map(x => x.uid));
      const r = /^UID (\d+):(\*|\d+)/.exec(args); if (r) set = set.filter(x => (x.uid >= Number(r[1]) && (r[2] === '*' || x.uid <= Number(r[2]))) || (r[2] === '*' && x.uid === top));   // n:* always names the newest message
      const s = /SINCE (\d+)-(\w+)-(\d+)/.exec(args); if (s) set = set.filter(x => x.at >= Date.parse(`${s[1]} ${s[2]} ${s[3]} UTC`));
      const c = /X-GM-RAW "category:(\w+)"/.exec(args); if (c) set = set.filter(x => x.category === c[1]);
      sock.write(`* SEARCH${set.map(x => ' ' + x.uid).join('')}\r\n`); return ok();
    }
    if (verb === 'UID FETCH') {
      const f = /^(\S+) \((.*)\)$/.exec(args), want = new Set(f[1].split(',').map(Number)), cap = Number(/<0\.(\d+)>/.exec(f[2])[1]);
      st.messages.forEach((x, i) => { if (!want.has(x.uid)) return; const raw = Buffer.from(x.raw, 'latin1'), part = raw.subarray(0, cap);
        sock.write(Buffer.concat([Buffer.from(`* ${i + 1} FETCH (X-GM-THRID ${x.thrid} X-GM-MSGID ${x.msgid} X-GM-LABELS (${x.labels.join(' ')}) UID ${x.uid} RFC822.SIZE ${raw.length} INTERNALDATE "${imapDate(x.at)}" BODY[]<0> {${part.length}}\r\n`), part, Buffer.from(')\r\n')])); });
      sock.write('* 1 FETCH (FLAGS (\\Seen))\r\n');                 // servers mention other changes in passing
      return ok();
    }
    if (verb === 'LOGOUT') { sock.write('* BYE logging out\r\n'); ok(); return sock.end(); }
    sock.write(`${tag} BAD unknown command\r\n`);
  };
  const server = net.createServer(sock => { st.sockets.add(sock); sock.on('error', () => {}); sock.write('* OK Gimap stand-in ready\r\n'); let buf = '';
    sock.on('data', d => { buf += d.toString('latin1'); for (let i; (i = buf.indexOf('\r\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 2); handle(sock, line); } }); });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return { st, open: () => net.connect(server.address().port, '127.0.0.1'), close: () => { for (const s of st.sockets) s.destroy(); server.close(); } };
}
const mailbox = () => [
  { uid: 3, msgid: '1278455344230334865', thrid: '1278455344230334865', labels: ['"\\\\Inbox"'], at: NOW - 10 * DAY, raw: SCHOOL },                        // older than the first run reaches
  { uid: 5, msgid: '1851234567890123456', thrid: '1851234567890123456', labels: ['"\\\\Inbox"', '"\\\\Important"'], at: NOW - 2 * DAY, raw: SCHOOL },
  { uid: 6, msgid: '1851234567890123999', thrid: '1851234567890123999', labels: ['"\\\\Inbox"', 'Receipts', '"Caf&AOk-"'], at: NOW - DAY, raw: CAFE, category: 'promotions' },
  { uid: 7, msgid: '1851234567890124001', thrid: '1851234567890123456', labels: ['"\\\\Sent"'], at: NOW - DAY / 2, raw: REPLY },
  { uid: 8, msgid: '1851234567890124002', thrid: '1851234567890124002', labels: ['"\\\\Draft"'], at: NOW - DAY / 4, raw: REPLY },
];

test('responses are cut where they end, literals included, and split into their parts', () => {
  const whole = Buffer.from('* 1 FETCH (UID 5 BODY[]<0> {12}\r\nline\r\n)(\r\n\r\n X-GM-LABELS ("\\\\Inbox" "a \\"b\\"" plain))\r\n* 2 EXISTS\r\n', 'latin1'), end = frame(whole);
  assert.equal(whole.latin1Slice(end), '* 2 EXISTS\r\n', 'a literal may hold line ends and brackets without ending the response');
  for (let n = 1; n < end; n++) assert.equal(frame(whole.subarray(0, n)), null, `not complete at ${n} bytes`);
  const t = tokens(whole.subarray(0, end));
  assert.deepEqual(t.slice(0, 3), ['*', '1', 'FETCH']); assert.deepEqual(t[3].slice(0, 3), ['UID', '5', 'BODY[]<0>']);
  assert.equal(t[3][3].toString('latin1'), 'line\r\n)(\r\n\r\n'); assert.deepEqual(t[3].slice(4), ['X-GM-LABELS', ['\\Inbox', 'a "b"', 'plain']]);
  assert.deepEqual(tokens(Buffer.from('* LIST (\\All) "/" "[Gmail]/All Mail"\r\n')), ['*', 'LIST', ['\\All'], '/', '[Gmail]/All Mail']);
  assert.doesNotThrow(() => tokens(Buffer.from('* OK it"s (unbalanced {9} [text\r\n')));
});

test('mail is read as a person would: encoded words, quoted-printable, HTML, attachments, and damage never throws', () => {
  const cafe = readMail(Buffer.from(CAFE, 'latin1'));
  assert.equal(cafe.header('from'), 'Café Lumière <news@cafe-lumiere.example>'); assert.equal(cafe.header('subject'), 'Our winter menu ❄ is here');
  assert.equal(cafe.text, 'Chestnut soup and a café crème you will not forget.'); assert.equal(cafe.fromHtml, false); assert.equal(cafe.attachments, 1);
  const bill = readMail(Buffer.from(HTML_ONLY, 'latin1')); assert.equal(bill.text, 'Amount due: 42 £\nPay by 30 November & avoid a fee.'); assert.equal(bill.fromHtml, true);
  assert.equal(headerText('=?iso-8859-1?Q?J=F6rg?= <j@example.invalid>'), 'Jörg <j@example.invalid>');
  assert.equal(readMail(Buffer.from(CAFE, 'latin1').subarray(0, 520)).header('subject'), 'Our winter menu ❄ is here', 'a mail cut off part way still gives what was read');
  for (const junk of [Buffer.alloc(0), Buffer.from([0, 255, 13, 10, 13, 10, 45, 45]), Buffer.from('Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\n--x\r\n--x'), Buffer.from('Content-Type: text/plain; charset=no-such-charset\r\n\r\n\xff\xfe')])
    assert.doesNotThrow(() => { const m = readMail(junk); assert.equal(typeof m.text, 'string'); m.header('subject'); });
});

test('the login file: only something shaped like an app password is accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-gmail-imap-')), file = path.join(dir, 'login.json'), put = j => fs.writeFileSync(file, JSON.stringify(j));
  try {
    assert.match(readLogin(file).problem, /no readable login file/);
    put({ address: ' Me@Example.invalid ', appPassword: 'abcd efgh ijkl mnop' }); assert.deepEqual(readLogin(file), { address: ME, password: PASSWORD });
    put({ address: ME, appPassword: 'my-real-Passw0rd!' }); assert.match(readLogin(file).problem, /does not look like a Google app password/); assert.ok(!readLogin(file).problem.includes('Passw0rd'));
    put({ address: 'not an address', appPassword: PASSWORD }); assert.match(readLogin(file).problem, /not an email address/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('first run reads recent mail as history; later runs read only what is new; nothing is ever changed on the server', async () => {
  const g = await fakeGmail(mailbox());
  try {
    const bad = await openImap({ open: g.open });
    await assert.rejects(bad.login(ME, 'wrongwrongwrongw'), e => e instanceof ImapError && e.login === true && e.code === 'AUTHENTICATIONFAILED' && !e.message.includes('wrongwrong'));
    await assert.rejects(bad.login(ME, 'x"\r\nc9 DELETE INBOX'), /characters IMAP cannot carry/); bad.close();
    assert.equal(g.st.commands.length, 1, 'a password that could smuggle in a second command is never sent');

    const imap = await openImap({ open: g.open }); await imap.login(ME, PASSWORD);
    const first = await sync(imap, {}, { now: NOW });
    assert.deepEqual(first.state, { mailbox: '[Gmail]/All Mail', uidValidity: 7, lastUid: 8 }); assert.equal(first.first, true); assert.equal(first.gap, false);
    assert.deepEqual(first.items.map(i => i.sourceId), ['19b0e807ff03bac0', '19b0e807ff03bcdf', '19b0e807ff03bce1'], 'three days back, oldest first, no draft; ids as Google\'s API writes them');
    const [school, cafe, reply] = first.items;
    assert.deepEqual({ ...school, metadata: undefined }, { sourceId: '19b0e807ff03bac0', threadId: '19b0e807ff03bac0', origin: 'history', author: 'office@riverside-school.example', authorName: 'Riverside School Office',
      sourceTime: new Date(NOW - 2 * DAY).toISOString(), direction: 'incoming', kind: 'text', text: 'Subject: Early pickup on Friday\n\nSchool closes at 1pm this Friday.\nPlease reply by Wednesday.', metadata: undefined });
    assert.deepEqual(school.metadata, { subject: 'Early pickup on Friday', to: ME, labels: ['INBOX', 'IMPORTANT'], attachments: undefined, truncated: undefined, bodySource: 'plain', bulk: undefined });
    assert.deepEqual(cafe.metadata.labels, ['INBOX', 'Receipts', 'Caf&AOk-', 'CATEGORY_PROMOTIONS']); assert.equal(cafe.metadata.bulk, true); assert.equal(cafe.metadata.attachments, 1); assert.equal(cafe.authorName, 'Café Lumière');
    assert.equal(reply.direction, 'outgoing'); assert.equal(reply.threadId, school.threadId, 'a reply is filed in the thread it answers');

    const before = g.st.commands.length, quiet = await sync(imap, first.state, { now: NOW });
    assert.deepEqual(quiet.items, []); assert.deepEqual(quiet.state, first.state);
    assert.deepEqual(g.st.commands.slice(before).map(c => c.verb), ['EXAMINE'], 'with nothing new, one cheap question and no fetch');

    g.st.messages.push({ uid: 9, msgid: '1851234567890125000', thrid: '1851234567890125000', labels: ['"\\\\Inbox"'], at: NOW, raw: HTML_ONLY, category: 'updates' });
    const next = await sync(imap, quiet.state, { now: NOW });
    assert.equal(next.items.length, 1); assert.equal(next.state.lastUid, 9); assert.equal(next.first, false);
    assert.equal(next.items[0].feed, 'inbox'); assert.equal(next.items[0].origin, undefined); assert.equal(next.items[0].metadata.bodySource, 'html'); assert.deepEqual(next.items[0].metadata.labels, ['INBOX', 'CATEGORY_UPDATES']);
    assert.equal(next.items[0].text, 'Subject: Your invoice\n\nAmount due: 42 £\nPay by 30 November & avoid a fee.');

    for (let u = 10; u < 14; u++) g.st.messages.push({ uid: u, msgid: String(1851234567890126000n + BigInt(u)), thrid: String(1851234567890126000n + BigInt(u)), labels: ['"\\\\Inbox"'], at: NOW, raw: SCHOOL });
    const part = await sync(imap, next.state, { now: NOW, maxPass: 3 }); assert.equal(part.items.length, 3); assert.equal(part.state.lastUid, 12, 'a backlog is read over several passes, oldest first');
    const rest = await sync(imap, part.state, { now: NOW, maxPass: 3 }); assert.equal(rest.items.length, 1); assert.equal(rest.state.lastUid, 13);

    g.st.allMail = '[Gmail]/Alle Nachrichten';                       // the account's language changed, so the folder has a new name and new numbering
    g.st.uidValidity = 8;
    const again = await sync(imap, rest.state, { now: NOW });
    assert.equal(again.gap, true); assert.equal(again.first, true); assert.equal(again.state.mailbox, '[Gmail]/Alle Nachrichten'); assert.equal(again.state.uidValidity, 8);
    assert.ok(again.items.length >= 4 && again.items.every(i => i.origin === 'history'), 'starts again from recent mail; the core drops what it already has by id');
    await imap.logout();

    const sent = g.st.commands;
    assert.deepEqual([...new Set(sent.map(c => c.verb))].sort(), ['EXAMINE', 'LIST', 'LOGIN', 'LOGOUT', 'UID FETCH', 'UID SEARCH'], 'only commands that read');
    for (const c of sent.filter(c => c.verb === 'UID FETCH')) { assert.match(c.args, /BODY\.PEEK\[\]<0\.\d+>/, 'mail is fetched without marking it as read'); assert.doesNotMatch(c.args, /BODY\[|RFC822(?!\.SIZE)|FLAGS/); }
    assert.ok(!JSON.stringify(sent).includes(PASSWORD));
  } finally { g.close(); }
});

test('a huge mail is read from its first part only, and a message that is only an attachment still becomes an item', async () => {
  const big = mail({ From: 'scans@clinic.example', Subject: 'Your scan', 'Content-Type': 'multipart/mixed; boundary=b' }, ['--b', 'Content-Type: text/plain', '', 'Results attached.', '--b', 'Content-Type: image/png; name="scan.png"', 'Content-Transfer-Encoding: base64', '', 'A'.repeat(900_000), '--b--', ''].join('\r\n'));
  const only = mail({ From: 'scans@clinic.example', Subject: 'Scan', 'Content-Type': 'application/pdf; name="scan.pdf"', 'Content-Transfer-Encoding': 'base64' }, 'B'.repeat(900_000));
  const g = await fakeGmail([{ uid: 1, msgid: '21', thrid: '21', labels: [], at: NOW, raw: big }, { uid: 2, msgid: '22', thrid: '22', labels: [], at: NOW, raw: only }]);
  try {
    const imap = await openImap({ open: g.open }); await imap.login(ME, PASSWORD);
    const [a, b] = await imap.fetch([1, 2]); assert.equal(a.raw.length, 262_144); assert.equal(a.size, big.length);
    const x = toItem(a), y = toItem(b);
    assert.equal(x.text, 'Subject: Your scan\n\nResults attached.'); assert.equal(x.metadata.attachments, 1); assert.equal(x.sourceId, '15'); assert.equal(x.metadata.truncated, undefined);
    assert.equal(y.text, 'Subject: Scan\n\n'); assert.equal(y.metadata.bodySource, 'none'); assert.equal(y.metadata.truncated, true);
    imap.close();
  } finally { g.close(); }
});

test('the program itself: asks for a login when there is none, and reads the sample mail when `clockwork check` hands it fixtures', async () => {
  const got = [], core = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d).on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{"received":0,"new":0}'); }); });
  await new Promise(ok => core.listen(0, '127.0.0.1', ok));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-gmail-imap-'));
  const run = extra => new Promise(ok => spawn(process.execPath, ['main.mjs', '--once'], { cwd: HERE, stdio: 'ignore', env: { PATH: process.env.PATH, CLOCKWORK_CORE_URL: `http://127.0.0.1:${core.address().port}`, CLOCKWORK_INGEST_TOKEN: 'ingest-only', CLOCKWORK_EXTRACTOR_DATA: data, ...extra } }).on('exit', ok));
  try {
    await run({}); assert.deepEqual(got, [{ auth: 'Bearer ingest-only', body: { source: 'gmail', events: [], status: 'needs_login' } }]);
    got.length = 0; await run({ CLOCKWORK_FIXTURES: path.join(HERE, 'fixtures') });
    assert.equal(got.length, 1); assert.deepEqual(got[0].body.events.map(e => e.metadata.subject), ['Our winter menu is here ❄', 'Early pickup on Friday']);
    assert.equal(got[0].body.events[0].authorName, 'Café Lumière'); assert.match(got[0].body.events[0].text, /a café crème you will not forget\. Book a table/); assert.equal(got[0].body.events[0].metadata.attachments, 1);
    assert.ok(!fs.existsSync(path.join(data, 'state.json')), 'a fixture run keeps no state');
  } finally { core.close(); core.closeAllConnections(); fs.rmSync(data, { recursive: true, force: true }); }
});
