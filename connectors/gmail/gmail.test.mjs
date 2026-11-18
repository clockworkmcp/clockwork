import test from 'node:test'; import assert from 'node:assert/strict';
import { createClient, sync, toEvent } from './gmail.mjs';

const enc = s => Buffer.from(s).toString('base64url');
const msg = (id, { labels = ['INBOX'], from = 'Dana Levi <Dana@Example.com>', subject = 'Hi', plain, html, extraHeaders = [], parts } = {}) => ({
  id, threadId: 't-' + id, labelIds: labels, internalDate: '1794400000000', snippet: 'snippet text',
  payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'To', value: 'me@example.com' }, ...extraHeaders],
    parts: parts ?? [plain !== undefined && { mimeType: 'text/plain', body: { data: enc(plain) } }, html !== undefined && { mimeType: 'text/html', body: { data: enc(html) } }].filter(Boolean) },
});

test('toEvent: plain body preferred, sender parsed, direction from labels', () => {
  const e = toEvent(msg('1', { plain: 'Pickup moved to 15:00', html: '<p>ignored</p>' }));
  assert.equal(e.text, 'Subject: Hi\n\nPickup moved to 15:00'); assert.equal(e.author, 'dana@example.com'); assert.equal(e.authorName, 'Dana Levi');
  assert.equal(e.direction, 'incoming'); assert.equal(e.feed, 'inbox'); assert.equal(e.metadata.bodySource, 'plain'); assert.equal(e.sourceTime, '2026-11-11T12:26:40.000Z');
  assert.equal(toEvent(msg('2', { labels: ['SENT'], plain: 'x' })).direction, 'outgoing');
});

test('toEvent: html fallback is stripped, snippet is the last resort, bulk and attachments are flagged', () => {
  const e = toEvent(msg('1', { html: '<style>p{}</style><p>Your order &amp; receipt</p><br>Total&nbsp;$5', extraHeaders: [{ name: 'List-Unsubscribe', value: '<x>' }] }));
  assert.equal(e.text, 'Subject: Hi\n\nYour order & receipt\n\nTotal $5'); assert.equal(e.metadata.bodySource, 'html'); assert.equal(e.metadata.bulk, true);
  const s = toEvent(msg('2', { parts: [{ mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'x' } }] }));
  assert.equal(s.text, 'Subject: Hi\n\nsnippet text'); assert.equal(s.metadata.bodySource, 'snippet'); assert.equal(s.metadata.attachments, 1);
});

test('toEvent: drafts, spam, trash and chats are never ingested; long bodies are truncated and marked', () => {
  for (const l of ['DRAFT', 'SPAM', 'TRASH', 'CHAT']) assert.equal(toEvent(msg('1', { labels: [l], plain: 'x' })), null);
  const e = toEvent(msg('1', { plain: 'a'.repeat(9000) })); assert.equal(e.text.length, 6000); assert.equal(e.metadata.truncated, true);
});

// A fake Gmail API: routes by path, records calls.
function fakeGmail({ messages, history, historyStatus = 200, profileHistoryId = '100' }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    url = new URL(url); calls.push(url.pathname.split('/users/me/')[1] ?? 'token');
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'at', expires_in: 3600 });
    assert.equal(init.headers.authorization, 'Bearer at');
    const p = url.pathname.split('/users/me/')[1];
    if (p === 'profile') return json({ historyId: profileHistoryId, emailAddress: 'me@example.com' });
    if (p === 'messages') return json({ messages: Object.keys(messages).map(id => ({ id })) });
    if (p === 'history') return historyStatus === 404 ? json({}, 404) : json({ history, historyId: '250' });
    if (p.startsWith('messages/')) { const m = messages[p.slice(9)]; return m ? json(m) : json({}, 404); }
    throw new Error('unexpected ' + p);
  };
  return { client: createClient({ clientId: 'c', refreshToken: 'r', fetchImpl }), calls };
}

test('sync: first run bootstraps recent mail and records the mailbox position', async () => {
  const { client } = fakeGmail({ messages: { a: msg('a', { plain: 'one' }), b: msg('b', { labels: ['SPAM'], plain: 'two' }) } });
  const r = await sync(client, {});
  assert.equal(r.bootstrapped, true); assert.deepEqual(r.events.map(e => e.sourceId), ['a']); assert.equal(r.state.historyId, '100');
});

test('sync: incremental run fetches only added messages, dedupes, skips deleted, advances the cursor', async () => {
  const { client, calls } = fakeGmail({ messages: { n1: msg('n1', { plain: 'new' }) },
    history: [{ messagesAdded: [{ message: { id: 'n1' } }, { message: { id: 'gone' } }] }, { messagesAdded: [{ message: { id: 'n1' } }] }] });
  const r = await sync(client, { historyId: '200' });
  assert.equal(r.bootstrapped, false); assert.deepEqual(r.events.map(e => e.sourceId), ['n1']); assert.equal(r.state.historyId, '250');
  assert.equal(calls.filter(c => c === 'messages/n1').length, 1);
});

test('sync: an expired cursor is reported as a gap and re-bootstraps instead of silently skipping', async () => {
  const { client } = fakeGmail({ historyStatus: 404, messages: { a: msg('a', { plain: 'one' }) }, profileHistoryId: '900' });
  const r = await sync(client, { historyId: '5', gaps: 1 });
  assert.equal(r.gap, true); assert.equal(r.bootstrapped, true); assert.equal(r.state.historyId, '900'); assert.equal(r.state.gaps, 2);
});

test('toEvent: hostile HTML entities cannot crash parsing; fetch falls back to the snippet on a malformed message', async () => {
  assert.equal(toEvent(msg('1', { html: 'a&#99999999999;b&#55296;c&#65;' })).text, 'Subject: Hi\n\na b cA');
  const bad = msg('bad', { plain: 'x' }); bad.payload.parts = [{ mimeType: 'text/plain', body: { get data() { throw new Error('boom'); } } }];
  const { client } = fakeGmail({ messages: { ok: msg('ok', { plain: 'fine' }) } });
  const realGet = client.get; client.get = async (p, q) => p === 'messages/bad' ? bad : realGet(p, q);
  const r = await sync({ get: async (p, q) => p === 'history' ? { history: [{ messagesAdded: [{ message: { id: 'ok' } }, { message: { id: 'bad' } }] }], historyId: '9' } : client.get(p, q) }, { historyId: '1' });
  assert.deepEqual(r.events.map(e => [e.sourceId, e.metadata.bodySource]), [['ok', 'plain'], ['bad', 'snippet']]);
});
