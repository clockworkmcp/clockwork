// search_items: the agent can find and read past items whatever was decided about them. All messages here are made up.
import test from 'node:test'; import assert from 'node:assert/strict';
import { openStore } from '../store.mjs';
import { createApp } from '../server.mjs';

test('search finds items in every bucket by word, sender, chat, source and time, pages, and reads one conversation whole', async () => {
  const s = openStore(':memory:'), t = m => new Date(Date.now() - m * 60e3).toISOString();
  s.ingest('whatsapp', [
    { sourceId: 'a1', threadId: 'fam', author: 'dana@s', authorName: 'Dana Example', sourceTime: t(300), text: 'Dentist moved to Thursday at 4', isGroup: true, chatName: 'Family' },
    { sourceId: 'a2', threadId: 'fam', author: 'me', sourceTime: t(290), text: 'ok, thursday works', direction: 'outgoing', isGroup: true, chatName: 'Family' },
    { sourceId: 'a3', threadId: 'fam', author: 'sam@s', authorName: 'Sam Example', sourceTime: t(100), text: 'Who has the 100% discount_code?', isGroup: true, chatName: 'Family' },
    { sourceId: 'b1', threadId: 'promo', author: 'shop@s', authorName: 'Shop', sourceTime: t(200), text: 'SALE: everything 50% off until Thursday' },
    { sourceId: 'c1', threadId: 'new', author: 'new@s', authorName: 'New Person', sourceTime: t(5), text: 'not classified yet' }]);
  s.ingest('gmail', [{ sourceId: 'g1', threadId: 't1', author: 'office@school.example', authorName: 'School office', sourceTime: t(50), text: 'Pickup on Thursday is at noon' }]);
  s.decide('whatsapp:fam:a1', { bucket: 'urgent', stage: 'teacher' }); s.decide('whatsapp:fam:a3', { bucket: 'later', stage: 'student' });
  s.decide('whatsapp:promo:b1', { bucket: 'ignore', stage: 'rule' }); s.decide('gmail:t1:g1', { bucket: 'later', stage: 'agent' });
  const app = createApp(s, { token: '', triage: async () => ({}) });
  const call = async (args = {}) => JSON.parse((await app.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_items', arguments: args } })).result.content[0].text);
  const ids = r => r.items.map(i => i.id);

  const thursday = await call({ query: 'THURSDAY' });
  assert.deepEqual(ids(thursday), ['gmail:t1:g1', 'whatsapp:promo:b1', 'whatsapp:fam:a1'], 'any case, every bucket, newest first, the user\'s own message left out');
  assert.deepEqual(thursday.items.map(i => i.bucket), ['later', 'ignore', 'urgent']); assert.ok(thursday.notice); assert.equal(thursday.more, false);
  assert.deepEqual(ids(await call({ query: 'thursday dentist' })), ['whatsapp:fam:a1'], 'every word must appear');
  assert.deepEqual(ids(await call({ query: 'thursday', bucket: 'ignore' })), ['whatsapp:promo:b1']);
  assert.deepEqual(ids(await call({ query: 'thursday', source: 'gmail' })), ['gmail:t1:g1']);
  assert.deepEqual(ids(await call({ from: 'school' })), ['gmail:t1:g1']); assert.deepEqual(ids(await call({ query: 'dana' })), ['whatsapp:fam:a1'], 'a sender\'s name counts as a word');
  assert.deepEqual(ids(await call({ chat: 'fami' })), ['whatsapp:fam:a3', 'whatsapp:fam:a1']);
  assert.deepEqual(ids(await call({ sinceHours: 1 })), ['whatsapp:new:c1', 'gmail:t1:g1']);
  const fresh = (await call({ query: 'classified' })).items[0]; assert.equal(fresh.bucket, undefined); assert.equal(fresh.classifiedAt, undefined);
  // % and _ are ordinary characters, not wildcards.
  assert.deepEqual(ids(await call({ query: '100%' })), ['whatsapp:fam:a3']); assert.deepEqual(ids(await call({ query: 'discount_code' })), ['whatsapp:fam:a3']); assert.deepEqual(ids(await call({ query: 'discountXcode' })), []);
  // Paging.
  const p1 = await call({ limit: 2 }); assert.equal(p1.more, true); const p2 = await call({ limit: 2, before: p1.nextBefore });
  assert.deepEqual([...ids(p1), ...ids(p2)], ['whatsapp:new:c1', 'gmail:t1:g1', 'whatsapp:fam:a3', 'whatsapp:promo:b1']);
  // One conversation, with what the user wrote.
  const chat = await call({ sameChatAs: 'whatsapp:fam:a3' });
  assert.deepEqual(ids(chat), ['whatsapp:fam:a3', 'whatsapp:fam:a2', 'whatsapp:fam:a1']); assert.equal(chat.items[1].yours, true); assert.equal(chat.items[0].chat, 'Family');
  assert.deepEqual(ids(await call({ query: 'ok', includeYours: true })), ['whatsapp:fam:a2']);
  const bad = await app.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_items', arguments: { sameChatAs: 'nope' } } });
  assert.ok(bad.error || bad.result?.isError, 'an unknown id is an error, not an empty list');
});
