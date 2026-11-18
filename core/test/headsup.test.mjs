import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { runOnce } from '../pipeline.mjs';
import { validateRules, matchRules, saveRules } from '../headsup.mjs';
import { createApp } from '../server.mjs';
import { HEADS_UP, EVENT } from '../events.mjs';

const NOW = new Date().toISOString();
const ev = (id, extra = {}) => ({ sourceId: id, threadId: 't1', author: '@a', sourceTime: NOW, text: 'hello ' + id, ...extra });
const SURE = { urgent: 0.01, later: 0.04, ignore: 0.95 };
// A trained, confident student; `flag` lists ids its urgent detector flags.
const student = (flag = []) => async events => ({ model: 'm', trainedSources: ['x', 'whatsapp'], scores: Object.fromEntries(events.map(e => [e.id, SURE])),
  urgentScores: Object.fromEntries(events.map(e => [e.id, flag.includes(e.id) ? 0.9 : 0.1])), urgentThresholds: { x: 0.5, whatsapp: 0.5 } });
const decision = (s, id) => ({ ...s.db.prepare('SELECT stage, bucket, heads_up_at, heads_up_reason FROM decisions WHERE event_id=?').get(id) });
const msg = (extra = {}) => ({ id: 'whatsapp:c1:m1', source: 'whatsapp', thread_id: 'c1', author: '111@s.whatsapp.net', author_name: 'Sam Example', is_group: false,
  kind: 'text', text: 'The boiler is leaking again', metadata: { subject: 'Flat 2' }, source_time: '2026-03-04T23:30:00Z', observed_at: '2026-03-04T23:31:00Z', ...extra });

test('heads-up rules: every condition must hold, and each field matches as documented', () => {
  process.env.CLOCKWORK_TZ = 'UTC';
  try {
    const m = msg(); const hit = r => matchRules([{ name: 'r', ...r }], m).length === 1;
    assert.ok(hit({ source: 'whatsapp' })); assert.ok(!hit({ source: 'gmail' }));
    assert.ok(hit({ isGroup: false })); assert.ok(!hit({ isGroup: true })); assert.ok(matchRules([{ name: 'g', isGroup: true }], msg({ is_group: 1 })).length);
    assert.ok(hit({ chats: ['c9', 'c1'] })); assert.ok(!hit({ chats: ['C1'] }), 'chats is exact');
    assert.ok(hit({ senders: ['111@s.whatsapp.net'] })); assert.ok(!hit({ senders: ['111'] }), 'senders is exact');
    assert.ok(hit({ senderContains: ['sam ex'] })); assert.ok(hit({ senderContains: ['nobody', '111@'] })); assert.ok(!hit({ senderContains: ['alex'] }));
    assert.ok(hit({ anyWords: ['fire', 'LEAKING'] })); assert.ok(!hit({ anyWords: ['fire'] }));
    assert.ok(hit({ allWords: ['boiler', 'flat 2'] }), 'the subject counts as text'); assert.ok(!hit({ allWords: ['boiler', 'fire'] }));
    assert.ok(hit({ notWords: ['fire'] })); assert.ok(!hit({ notWords: ['Boiler'] }));
    assert.ok(hit({ kinds: ['text', 'image'] })); assert.ok(!hit({ kinds: ['image'] }));
    // 23:30 UTC on a Wednesday.
    assert.ok(hit({ hours: [22, 7] }), 'a range may wrap midnight'); assert.ok(hit({ hours: [23, 24] })); assert.ok(!hit({ hours: [7, 22] })); assert.ok(!hit({ hours: [0, 23] }), 'the end hour is not included');
    assert.ok(matchRules([{ name: 'n', hours: [22, 7] }], msg({ source_time: '2026-03-05T03:00:00Z' })).length, 'after midnight, inside a wrapped range');
    assert.ok(hit({ days: ['wed'] })); assert.ok(!hit({ days: ['sat', 'sun'] }));
    assert.ok(matchRules([{ name: 'o', hours: [23, 24] }], msg({ source_time: null })).length, 'without a sent time, the time it was seen is used');
    process.env.CLOCKWORK_TZ = 'Asia/Tokyo'; // 08:30 on Thursday there
    assert.ok(hit({ hours: [8, 9], days: ['thu'] })); assert.ok(!hit({ hours: [22, 7] }));
    assert.ok(!hit({ source: 'whatsapp', anyWords: ['fire'] }), 'all conditions must hold');
    assert.deepEqual(matchRules([{ name: 'a', anyWords: ['fire'] }, { name: 'b', source: 'whatsapp' }, { name: 'c', anyWords: ['boiler'] }], m), ['b', 'c']);
    assert.deepEqual(matchRules([], m), []);
  } finally { delete process.env.CLOCKWORK_TZ; }
});

test('heads-up rules: validation names the rule and field at fault', () => {
  const ok = [{ name: 'Landlord', why: 'repairs', source: 'whatsapp', isGroup: false, chats: ['c1'], senders: ['@a'], senderContains: ['sam'], anyWords: ['leak'],
    allWords: ['boiler'], notWords: ['newsletter'], kinds: ['text'], hours: [22, 7], days: ['mon', 'sun'] }];
  assert.equal(validateRules(ok), ok);
  const no = (rules, re) => assert.throws(() => validateRules(rules), e => e.status === 400 && re.test(e.message), re.source);
  no({}, /must be a list/);
  no(Array.from({ length: 201 }, (_, i) => ({ name: 'r' + i, source: 'x' })), /at most 200 rules/);
  no(['x'], /rule 1: must be an object/);
  no([{ source: 'x' }], /rule 1: name/);
  no([{ name: 'a', source: 'x' }, { name: 'a', source: 'x' }], /rule 2 \("a"\): name is used/);
  no([{ name: 'a', colour: 'red' }], /rule 1 \("a"\): colour is not a known field/);
  no([{ name: 'a' }], /needs at least one condition/);
  no([{ name: 'a', why: 'just because' }], /needs at least one condition/);
  no([{ name: 'a', source: 'x', why: 'w'.repeat(201) }], /why/);
  no([{ name: 'a', source: 5 }], /source/);
  no([{ name: 'a', isGroup: 'yes' }], /isGroup/);
  no([{ name: 'a', anyWords: [] }], /anyWords must be a list/);
  no([{ name: 'a', senders: 'bob' }], /senders/);
  no([{ name: 'a', kinds: ['text', ''] }], /kinds/);
  no([{ name: 'a', notWords: Array(201).fill('w') }], /notWords/);
  no([{ name: 'a', allWords: ['w'.repeat(201)] }], /allWords/);
  for (const hours of [[1], [1, 2, 3], [-1, 3], [3, 25], [24, 1], [5, 5], [1.5, 3], null, '22-7']) no([{ name: 'a', hours }], /hours/);
  no([{ name: 'a', days: ['monday'] }], /days/);
  no([{ name: 'n'.repeat(81), source: 'x' }], /name/);
});

test('pipeline: a rule match or a detector flag raises a heads-up, and a rule match stops the student filing the item alone', async () => {
  const s = openStore(':memory:'); s.kv.set('shadow:x', 'off'); s.kv.set('shadow:whatsapp', 'off'); // the student may decide alone
  saveRules(s, [{ name: 'Leaks', anyWords: ['leak'] }]);
  const [ruled, flagged, plain] = s.ingest('x', [ev('r1', { threadId: 'a', text: 'a leak upstairs' }), ev('f1', { threadId: 'b' }), ev('p1', { threadId: 'c' })]);
  const [own] = s.ingest('x', [ev('o1', { threadId: 'd', direction: 'outgoing', text: 'my own leak note' })]);
  const c = await runOnce(s, { student: student([flagged]), mode: 'agent' });
  assert.deepEqual([c.student, c.pending_agent, c.heads_up, c.rule], [1, 2, 2, 1]);
  assert.deepEqual({ ...decision(s, ruled), heads_up_at: typeof decision(s, ruled).heads_up_at }, { stage: 'pending_agent', bucket: 'later', heads_up_at: 'number', heads_up_reason: 'rule: Leaks' });
  assert.deepEqual([decision(s, flagged).stage, decision(s, flagged).bucket, decision(s, flagged).heads_up_reason], ['pending_agent', 'later', 'model'], 'a heads-up never changes the bucket');
  assert.deepEqual([decision(s, plain).stage, decision(s, plain).heads_up_at], ['student', null]);
  assert.deepEqual([decision(s, own).stage, decision(s, own).heads_up_at], ['rule', null], 'items the built-in rules decide are left alone');
  assert.ok(decision(s, flagged).heads_up_at > decision(s, ruled).heads_up_at, 'heads-up times are distinct, so they work as a cursor');
  // A later label keeps the heads-up on record.
  s.decide(ruled, { bucket: 'urgent', stage: 'agent' }); assert.equal(decision(s, ruled).heads_up_reason, 'rule: Leaks');

  // With the built-in teacher there are no heads-ups.
  const b = openStore(':memory:'); saveRules(b, [{ name: 'Leaks', anyWords: ['leak'] }]); const [bi] = b.ingest('x', [ev('r1', { text: 'leak' })]);
  await runOnce(b, { student: student([bi]), mode: 'builtin', teacher: async es => ({ model: 't', decisions: new Map(es.map(e => [e.id, { bucket: 'later', confidence: 'high' }])) }) });
  assert.equal(decision(b, bi).heads_up_at, null);
});

test('pipeline: heads-ups are held back within the gap for the same conversation, when the user already wrote, or when the message is old', async () => {
  const s = openStore(':memory:'); saveRules(s, [{ name: 'All of x', source: 'x' }]);
  const later = new Date(Date.now() + 1000).toISOString(), old = new Date(Date.now() - 13 * 3600e3).toISOString();
  const [a1, b1] = s.ingest('x', [ev('a1', { threadId: 'A' }), ev('b1', { threadId: 'B' })]);
  await runOnce(s, { student: student(), mode: 'agent' });
  assert.ok(decision(s, a1).heads_up_at && decision(s, b1).heads_up_at, 'one per conversation');
  const [a2, n1, n2] = s.ingest('x', [ev('a2', { threadId: 'A' }), ev('n1', { threadId: null, author: '@solo' }), ev('n2', { threadId: null, author: '@solo' })]);
  const c = await runOnce(s, { student: student(), mode: 'agent' });
  assert.deepEqual([c.pending_agent, c.heads_up], [3, 1]);
  assert.equal(decision(s, a2).heads_up_at, null, 'same thread within the hour: still waiting for a label, but no second wake-up');
  assert.equal(decision(s, a2).stage, 'pending_agent');
  assert.ok(decision(s, n1).heads_up_at); assert.equal(decision(s, n2).heads_up_at, null, 'without a thread, the same sender counts as the conversation');
  // Past the gap, the same thread may wake the agent again.
  s.db.prepare('UPDATE decisions SET heads_up_at=heads_up_at-?').run(61 * 60e3);
  const [a3] = s.ingest('x', [ev('a3', { threadId: 'A' })]); await runOnce(s, { student: student(), mode: 'agent' });
  assert.ok(decision(s, a3).heads_up_at);
  const [g1, g2] = s.ingest('x', [ev('g1', { threadId: 'G' }), ev('g2', { threadId: 'G' })]);
  await runOnce(s, { student: student(), mode: 'agent', headsUpGapMs: 0 });
  assert.ok(decision(s, g1).heads_up_at && decision(s, g2).heads_up_at, 'a gap of zero holds nothing back');

  // The user already wrote in the thread after the message.
  const [w1] = s.ingest('x', [ev('w1', { threadId: 'W' }), ev('w-me', { threadId: 'W', direction: 'outgoing', sourceTime: later })]);
  await runOnce(s, { student: student(), mode: 'agent' });
  assert.deepEqual([decision(s, w1).stage, decision(s, w1).heads_up_at], ['pending_agent', null]);
  // Too old to act on.
  const [o1] = s.ingest('x', [ev('o1', { threadId: 'O', sourceTime: old })]);
  await runOnce(s, { student: student(), mode: 'agent' });
  assert.deepEqual([decision(s, o1).stage, decision(s, o1).heads_up_at], ['pending_agent', null]);
});

test('events: heads_up_item pushes the id only, advances its cursor, skips items labelled since, and leaves urgent_item as it was', async () => {
  const s = openStore(':memory:'); const posts = [];
  const eventPost = async (url, body) => { const m = JSON.parse(body); if (m.type === 'verification') return { status: 200, text: JSON.stringify({ challenge: m.challenge }) }; posts.push(m); return { status: 202, text: '' }; };
  const app = createApp(s, { triage: () => runOnce(s, { student: student(), mode: 'agent' }), eventPost, agentTeaches: true, studentHealth: async () => null });
  const call = (method, params) => app.mcp({ jsonrpc: '2.0', id: 1, method, params }, 'agent');
  const defs = (await call('events/list')).result.events;
  assert.deepEqual(defs.map(e => e.name), [EVENT, HEADS_UP]); assert.deepEqual(defs[1].payloadSchema.required, ['id']);
  const secret = 'whsec_' + Buffer.alloc(32, 3).toString('base64');
  for (const name of [HEADS_UP, EVENT]) assert.ok((await call('events/subscribe', { name, delivery: { mode: 'webhook', url: 'https://agent.example/' + name, secret } })).result.id);
  assert.equal(app.events.list().length, 2);
  await new Promise(r => setTimeout(r, 5)); posts.length = 0;
  saveRules(s, [{ name: 'Boiler', anyWords: ['boiler'] }]);
  const [h1] = s.ingest('whatsapp', [ev('h1', { threadId: 'A', text: 'SECRET boiler news' })]);
  await app.kick(); // a triage pass that raises a heads-up delivers it straight away
  assert.deepEqual(posts.map(p => [p.name, p.data]), [[HEADS_UP, { id: h1 }]]);
  assert.ok(!JSON.stringify(posts).includes('SECRET'));
  assert.equal(posts[0].cursor, String(decision(s, h1).heads_up_at));
  posts.length = 0; assert.equal(await app.events.deliver(), 0, 'not sent twice');

  // Raised, but labelled before it went out: skipped.
  const [h2, h3] = s.ingest('whatsapp', [ev('h2', { threadId: 'B', text: 'boiler' }), ev('h3', { threadId: 'C', text: 'boiler' })]);
  await runOnce(s, { student: student(), mode: 'agent' });
  posts.length = 0; // submit_labels delivers what is due once the labels are in
  assert.equal(JSON.parse((await call('tools/call', { name: 'submit_labels', arguments: { labels: [{ id: h2, bucket: 'later' }] } })).result.content[0].text).accepted, 1);
  await app.events.deliver();
  assert.deepEqual(posts.map(p => [p.name, p.data.id]), [[HEADS_UP, h3]]);
  // A heads-up is not an urgent item: urgent_item subscribers hear only of items decided urgent, as before.
  posts.length = 0; await app.events.deliver(); assert.equal(posts.length, 0);
  s.decide(h3, { bucket: 'urgent', stage: 'teacher' }); await app.events.deliver();
  assert.deepEqual(posts.map(p => [p.name, p.data]), [[EVENT, { id: h3, source: 'whatsapp' }]]);
});

test('MCP and admin HTTP: heads-up rules round-trip, bad rules are refused, and updates can be polled with a cursor', async () => {
  const s = openStore(':memory:');
  const { server } = createApp(s, { tokens: { admin: 'adm', agent: 'agt' }, triage: async () => ({}), agentTeaches: true, studentHealth: async () => null });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const call = async (name, args) => { const r = await (await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer agt', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json(); return r.result.isError ? { error: r.result.content[0].text } : JSON.parse(r.result.content[0].text); };
    assert.deepEqual(await call('get_heads_up_rules', {}), { rules: [] });
    const rules = [{ name: 'School', why: 'pickups', senderContains: ['school'] }, { name: 'Nights', hours: [22, 7], isGroup: false }];
    assert.deepEqual(await call('set_heads_up_rules', { rules }), { saved: 2 });
    assert.deepEqual(await call('get_heads_up_rules', {}), { rules });
    assert.match((await call('set_heads_up_rules', { rules: [{ name: 'x', bogus: 1 }] })).error, /bogus is not a known field/);
    assert.deepEqual((await call('get_heads_up_rules', {})).rules, rules, 'a refused list leaves the old one in place');

    const admin = (method, body, tok = 'adm') => fetch(base + '/heads-up-rules', { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    assert.deepEqual(await (await admin('GET')).json(), { rules });
    assert.deepEqual(await (await admin('PUT', { rules: [rules[0]] })).json(), { saved: 1 });
    assert.deepEqual(await (await admin('PUT', [rules[1]])).json(), { saved: 1 });
    assert.equal((await admin('PUT', { rules: [{ name: 'empty' }] })).status, 400);
    assert.equal((await admin('GET', undefined, 'agt')).status, 403); assert.equal((await admin('PUT', [], 'agt')).status, 403);
    assert.equal((await fetch(base + '/heads-up-rules', { method: 'PUT', headers: { authorization: 'Bearer adm', 'content-type': 'text/plain' }, body: '[]' })).status, 415);
    assert.deepEqual((await call('get_heads_up_rules', {})).rules, [rules[1]]);

    const [a, b] = s.ingest('gmail', [ev('a', { threadId: 'A', text: 'SECRET first' }), ev('b', { threadId: 'B' })]);
    for (const id of [a, b]) s.decide(id, { bucket: 'later', stage: 'pending_agent' });
    s.raiseHeadsUp(a, 'rule: School'); s.raiseHeadsUp(b, 'model');
    const first = await call('get_heads_up_updates', {});
    assert.deepEqual(first.items.map(i => [i.id, i.headsUpWhy, i.decidedBy]), [[a, 'rule: School', 'pending_agent'], [b, 'model', 'pending_agent']]);
    assert.match(first.notice, /untrusted/);
    assert.deepEqual((await call('get_heads_up_updates', { cursor: first.cursor })).items, []);
    assert.equal((await call('get_heads_up_updates', { cursor: first.cursor })).cursor, first.cursor);
    s.label(a, 'urgent', 'agent', 'high', ''); s.decide(a, { bucket: 'urgent', stage: 'agent' });
    assert.deepEqual((await call('get_heads_up_updates', {})).items.map(i => i.id), [b], 'labelled items drop out');
    const q = await (await fetch(base + '/quality', { headers: { authorization: 'Bearer adm' } })).json();
    assert.deepEqual(q.headsUps, { raised: 2, byReason: { rule: 1, model: 1 }, labelledSince: 1, labelledUrgent: 1 });
  } finally { server.close(); }
});

test('heads-up tools are offered only where the agent labels items', async () => {
  const s = openStore(':memory:'); const app = createApp(s, { triage: async () => ({}), agentTeaches: false, studentHealth: async () => null });
  const names = (await app.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'agent')).result.tools.map(t => t.name);
  assert.ok(!names.includes('set_heads_up_rules') && !names.includes('get_heads_up_updates'));
});

test('a database made before heads-ups gains the new columns and keeps its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-migrate-')); const file = path.join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE events(id TEXT PRIMARY KEY, source TEXT NOT NULL, feed TEXT, thread_id TEXT, author TEXT, author_name TEXT, source_time TEXT, observed_at TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'incoming', is_group INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'text', text TEXT NOT NULL DEFAULT '', url TEXT, metadata TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE decisions(event_id TEXT PRIMARY KEY REFERENCES events(id), bucket TEXT NOT NULL, stage TEXT NOT NULL,
        p_urgent REAL, p_later REAL, p_ignore REAL, reason TEXT, model TEXT, decided_at INTEGER NOT NULL, delivered_at INTEGER);
      INSERT INTO events(id, source, observed_at, text, created_at) VALUES ('x:old', 'x', '${NOW}', 'an old made-up post', 1);
      INSERT INTO decisions(event_id, bucket, stage, decided_at) VALUES ('x:old', 'later', 'pending_agent', 1);`);
    old.close();
    const s = openStore(file);
    assert.deepEqual(decision(s, 'x:old'), { stage: 'pending_agent', bucket: 'later', heads_up_at: null, heads_up_reason: null });
    s.raiseHeadsUp('x:old', 'model'); assert.equal(decision(s, 'x:old').heads_up_reason, 'model');
    s.db.close();
    assert.equal(decision(openStore(file), 'x:old').heads_up_reason, 'model', 'opening again changes nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
