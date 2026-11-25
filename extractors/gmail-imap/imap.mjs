// A small IMAP client that can only read: just enough of the protocol to follow one Gmail mailbox, with no dependencies.
// Read-only by construction. The mailbox is opened with EXAMINE, which the server itself treats as read-only, and mail is
// fetched with BODY.PEEK, which does not mark it as read. This file can send LOGIN, LIST, EXAMINE, UID SEARCH, UID FETCH
// and LOGOUT and has no way to send anything else: nothing here can flag, move, delete, append or send.
import tls from 'node:tls';

export const HOST = 'imap.gmail.com';
const CRLF = Buffer.from('\r\n'), MAX_PENDING = 16 * 1024 * 1024;
export class ImapError extends Error {}

/** Where the first whole response in `buf` ends (a line, plus any `{n}` literals it carries), or null while bytes are missing. */
export function frame(buf) {
  for (let pos = 0; ;) {
    const nl = buf.indexOf(CRLF, pos); if (nl < 0) return null;
    const lit = /\{(\d+)\}$/.exec(buf.toString('latin1', Math.max(pos, nl - 24), nl));
    if (!lit) return nl + 2;
    pos = nl + 2 + Number(lit[1]); if (pos > buf.length) return null;
  }
}

/** The parts of one response: atoms and quoted strings as strings, literals as Buffers, parenthesised lists as arrays. */
export function tokens(buf) {
  const root = [], stack = [root], top = () => stack[stack.length - 1];
  for (let i = 0; i < buf.length;) {
    const c = buf[i];
    if (c === 0x20 || c === 0x0d || c === 0x0a) { i++; continue; }
    if (c === 0x28) { const list = []; top().push(list); stack.push(list); i++; continue; }
    if (c === 0x29) { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === 0x22) {                                                // "quoted", with \" and \\ inside
      let s = ''; i++;
      while (i < buf.length && buf[i] !== 0x22 && buf[i] !== 0x0d) { if (buf[i] === 0x5c) i++; s += String.fromCharCode(buf[i++]); }
      i++; top().push(Buffer.from(s, 'latin1').toString('utf8')); continue;
    }
    if (c === 0x7b) {                                                // {n}CRLF then n bytes, taken as they are
      const lit = /^\{(\d+)\}\r\n/.exec(buf.toString('latin1', i, i + 24));
      if (lit) { const start = i + lit[0].length, n = Number(lit[1]); top().push(buf.subarray(start, start + n)); i = start + n; continue; }
    }
    let j = i, square = 0;                                           // an atom; BODY[...] keeps what is inside its brackets
    for (; j < buf.length; j++) {
      const d = buf[j]; if (d === 0x0d) break;
      if (d === 0x5b) square++; else if (d === 0x5d) square--; else if (square <= 0 && (d === 0x20 || d === 0x28 || d === 0x29)) break;
    }
    top().push(buf.toString('latin1', i, j)); i = Math.max(j, i + 1);
  }
  return root;
}

/** A value inside double quotes. Refuses anything that could start a second command. */
function quote(s, what) {
  if (typeof s !== 'string' || !s || /[^\x20-\x7e]/.test(s)) throw new ImapError(`${what} has characters IMAP cannot carry here`);
  return '"' + s.replace(/[\\"]/g, '\\$&') + '"';
}
/** A UID set this file built itself: numbers, ranges and `*`. */
const uidSet = s => { if (!/^(\d+|\*)(:(\d+|\*))?(,(\d+|\*)(:(\d+|\*))?)*$/.test(s)) throw new ImapError('not a UID set'); return s; };
const CATEGORIES = ['personal', 'updates', 'promotions', 'social', 'forums'];

/**
 * Connect and wait for the server's greeting. `open` returns the socket; by default a TLS connection to Gmail, checked
 * against Gmail's certificate. Tests pass their own.
 */
export async function openImap({ open = () => tls.connect({ host: HOST, port: 993, servername: HOST }), timeoutMs = 60_000 } = {}) {
  const socket = open(), queue = []; let buf = Buffer.alloc(0), waiting = null, closed = null, n = 0;
  const fail = e => { closed ||= e; socket.destroy(); waiting?.(); waiting = null; };
  socket.on('data', d => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (let end; (end = frame(buf)) !== null;) { queue.push(buf.subarray(0, end)); buf = buf.subarray(end); }
    if (buf.length > MAX_PENDING) return fail(new ImapError('the server sent more than this program will hold'));
    waiting?.(); waiting = null;
  });
  socket.on('timeout', () => fail(new ImapError('the mail server stopped answering')));
  socket.on('error', e => fail(new ImapError(`connection to the mail server failed: ${e.message}`)));
  socket.on('close', () => fail(new ImapError('the mail server closed the connection')));
  const next = async () => { for (;;) { if (queue.length) return queue.shift(); if (closed) throw closed; await new Promise(ok => { waiting = ok; }); } };

  /** Send one command and return the untagged responses that came before its OK. The command text is never put in an error. */
  async function command(text) {
    if (closed) throw closed;
    const tag = 'c' + (++n), verb = /^(UID )?[A-Z]+/.exec(text)[0], data = [];
    socket.setTimeout(timeoutMs); socket.write(`${tag} ${text}\r\n`);
    try {
      for (;;) {
        const r = await next(), head = r.toString('latin1', 0, Math.min(r.length, 300)).replace(/\r\n$/, '');
        if (head.startsWith(tag + ' ')) {
          const m = /^\S+ (OK|NO|BAD)\b ?(.*)$/.exec(head); if (m?.[1] === 'OK') return data;
          throw Object.assign(new ImapError(`${verb} was refused: ${m?.[2] || head}`), { code: /\[([A-Z-]+)[\] ]/.exec(m?.[2] || '')?.[1] });
        }
        if (/^\* BYE\b/i.test(head)) { fail(new ImapError(`the mail server ended the session: ${head.slice(6)}`)); throw closed; }
        data.push(r);
      }
    } finally { socket.setTimeout(0); }
  }

  socket.setTimeout(timeoutMs);
  const hello = (await next()).toString('latin1', 0, 200); socket.setTimeout(0);
  if (!/^\* (OK|PREAUTH)\b/i.test(hello)) { fail(new ImapError('the mail server did not greet us')); throw closed; }

  const search = async criteria => (await command(`UID SEARCH ${criteria}`)).map(tokens).filter(t => /^SEARCH$/i.test(t[1])).flatMap(t => t.slice(2).map(Number)).filter(Number.isSafeInteger);
  return {
    /** Sign in. On refusal the error carries `login: true`, and never the password. */
    async login(address, password) {
      try { await command(`LOGIN ${quote(address, 'the address')} ${quote(password, 'the app password')}`); }
      catch (e) { if (e.code === 'AUTHENTICATIONFAILED' || /^LOGIN was refused/.test(e.message)) e.login = true; throw e; }
    },
    /** The mailbox that holds all mail (received, sent and archived), whatever it is called in the account's language. */
    async allMail() {
      for (const t of (await command('LIST "" "*"')).map(tokens))
        if (/^LIST$/i.test(t[1]) && Array.isArray(t[2]) && t[2].some(f => /^\\All$/i.test(f)) && typeof t[4] === 'string') return t[4];
      return 'INBOX';                                                // "All Mail" is hidden from IMAP in this account's settings
    },
    /** Open a mailbox for reading only. */
    async examine(mailbox) {
      const lines = (await command(`EXAMINE ${quote(mailbox, 'the mailbox name')}`)).map(r => r.toString('latin1', 0, 200)), num = re => { for (const l of lines) { const m = re.exec(l); if (m) return Number(m[1]); } };
      return { uidValidity: num(/\[UIDVALIDITY (\d+)\]/i), uidNext: num(/\[UIDNEXT (\d+)\]/i), exists: num(/^\* (\d+) EXISTS/i) };
    },
    /** UIDs above `after`, oldest first. */
    async newer(after) { return (await search(`UID ${uidSet(`${after + 1}:*`)}`)).filter(u => u > after).sort((a, b) => a - b); },
    /** UIDs of mail that arrived on or after the day of `ms` (IMAP only knows whole days here), oldest first. */
    async since(ms) {
      const d = new Date(ms), day = `${d.getUTCDate()}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}-${d.getUTCFullYear()}`;
      return (await search(`SINCE ${day}`)).sort((a, b) => a - b);
    },
    /** Which of Gmail's inbox categories each of these messages is in: a map of UID to names such as `promotions`. */
    async categories(lo, hi) {
      const out = new Map();
      for (const c of CATEGORIES) for (const u of await search(`UID ${uidSet(`${lo}:${hi}`)} X-GM-RAW "category:${c}"`)) out.set(u, [...(out.get(u) || []), c]);
      return out;
    },
    /** Read messages without marking them as read: Gmail's own ids and labels, the arrival time, and the first `maxBytes` of each. */
    async fetch(uids, maxBytes = 262_144) {
      const out = [];
      for (const r of await command(`UID FETCH ${uidSet(uids.join(','))} (UID X-GM-MSGID X-GM-THRID X-GM-LABELS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.${Number(maxBytes)}>)`)) {
        const t = tokens(r); if (!/^FETCH$/i.test(t[2]) || !Array.isArray(t[3])) continue;
        const f = {}; for (let i = 0; i + 1 < t[3].length; i += 2) f[String(t[3][i]).toUpperCase().replace(/^BODY\[\].*/, 'BODY')] = t[3][i + 1];
        if (!f.UID || !/^\d+$/.test(f['X-GM-MSGID'] || '') || f.BODY === undefined) continue;   // a flag change the server mentions in passing
        out.push({ uid: Number(f.UID), msgid: f['X-GM-MSGID'], thrid: /^\d+$/.test(f['X-GM-THRID'] || '') ? f['X-GM-THRID'] : f['X-GM-MSGID'],
          labels: (Array.isArray(f['X-GM-LABELS']) ? f['X-GM-LABELS'] : []).map(String), internalDate: typeof f.INTERNALDATE === 'string' ? f.INTERNALDATE : undefined,
          size: Number(f['RFC822.SIZE']) || 0, raw: Buffer.isBuffer(f.BODY) ? f.BODY : Buffer.from(f.BODY === 'NIL' ? '' : String(f.BODY), 'latin1') });
      }
      return out.sort((a, b) => a.uid - b.uid);
    },
    async logout() { try { await command('LOGOUT'); } catch {} socket.destroy(); },
    close() { socket.destroy(); },
    get closed() { return !!closed; },
  };
}
