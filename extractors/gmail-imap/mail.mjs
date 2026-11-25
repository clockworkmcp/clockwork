// Reads the text out of one mail as it travels (RFC 5322 with MIME), with no dependencies. It is handed the first part
// of a message, which may be cut off in the middle, and must never throw on mail that is damaged or strange.

const byte = s => Buffer.from(s, 'latin1');
/** Bytes to text in the character set the mail names; when it names none, or one this machine does not know, UTF-8, then Western European. */
function text(bytes, charset) {
  if (charset) try { return new TextDecoder(charset.trim()).decode(bytes); } catch {}
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}
const quotedPrintable = s => s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
function body(bin, encoding = '') {
  const e = encoding.trim().toLowerCase();
  if (e === 'base64') return Buffer.from(bin.replace(/[^A-Za-z0-9+/]/g, ''), 'base64');
  return byte(e === 'quoted-printable' ? quotedPrintable(bin) : bin);
}
/** A header value as a person would read it: raw 8-bit text and `=?charset?B?...?=` words both decoded. */
export function headerText(v = '') {
  const s = /[\x80-\xff]/.test(v) ? text(byte(v)) : v;
  return s.replace(/(\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (_, cs, kind, t) =>
    text(kind.toLowerCase() === 'b' ? Buffer.from(t, 'base64') : byte(quotedPrintable(t.replace(/_/g, ' '))), cs.split('*')[0])).trim();
}
const param = (v, name) => { const m = new RegExp(`;\\s*${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(';' + (v || '')); return m ? (m[1] ?? m[2]) : undefined; };
function split(bin) { const m = /\r?\n\r?\n/.exec(bin); return m ? [bin.slice(0, m.index), bin.slice(m.index + m[0].length)] : [bin, '']; }
function headers(head) {
  const h = Object.create(null);
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) { const i = line.indexOf(':'), k = line.slice(0, i).trim().toLowerCase(); if (i > 0 && !(k in h)) h[k] = line.slice(i + 1).trim(); }
  return h;
}

function walk(bin, out, depth) {
  const [head, rest] = split(bin), h = headers(head), type = h['content-type'] || 'text/plain', kind = type.split(';')[0].trim().toLowerCase(), boundary = param(type, 'boundary');
  if (kind.startsWith('multipart/') && boundary && depth < 8) {
    for (const part of ('\n' + rest).split('\n--' + boundary).slice(1)) { if (part.startsWith('--')) break; walk(part.replace(/^[^\n]*\n/, '').replace(/\r$/, ''), out, depth + 1); }
    return h;
  }
  const disposition = h['content-disposition'] || '';
  if (/^\s*attachment/i.test(disposition) || param(disposition, 'filename') || param(type, 'name')) out.attachments++;
  else if (kind === 'text/plain') out.plain += text(body(rest, h['content-transfer-encoding']), param(type, 'charset'));
  else if (kind === 'text/html') out.html += text(body(rest, h['content-transfer-encoding']), param(type, 'charset'));
  return h;
}

export function htmlToText(html) {
  return html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) ? String.fromCodePoint(c) : ' '; }).replace(/&amp;/g, '&')
    .replace(/[ \t ​‌͏]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** One mail (or the start of one) to { header(name), text, fromHtml, attachments }. */
export function readMail(raw) {
  const out = { plain: '', html: '', attachments: 0 }; let top = Object.create(null);
  try { top = walk(Buffer.isBuffer(raw) ? raw.latin1Slice() : String(raw ?? ''), out, 0); } catch {}
  const plain = out.plain.trim();
  return { header: name => headerText(top[name]), text: (plain || htmlToText(out.html)).replace(/\r\n?/g, '\n').trim(), fromHtml: !plain && !!out.html.trim(), attachments: out.attachments };
}
