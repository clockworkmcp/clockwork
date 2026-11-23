// Setup is only finished when feeds deliver, the agent is connected, wake-ups are arranged and labelling has begun.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openStore } from '../store.mjs';
import { createApp } from '../server.mjs';

const SECRET = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-setup-')), store = openStore(path.join(dir, 'c.db'));
  // A receiver that passes the callback check and accepts every event.
  const eventPost = async (_url, body) => ({ status: 200, text: JSON.stringify({ challenge: JSON.parse(body).challenge }) });
  const app = createApp(store, { tokens: { admin: 'a', agent: 'g', ingest: 'i' }, agentTeaches: true, triage: async () => ({}), eventPost });
  const call = async (name, args = {}, role = 'agent') => JSON.parse((await app.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, role)).result.content[0].text);
  const step = (s, name) => s.steps.find(x => x.step === name);
  return { store, app, call, step, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a fresh install is not finished, and says what to do first', async () => {
  const { app, step, done } = fresh();
  try {
    const s = app.setupStatus();
    assert.equal(s.finished, false); assert.deepEqual(s.steps.map(x => x.step), ['feeds', 'agent_connected', 'wake_ups', 'labelling']);
    assert.ok(s.steps.every(x => !x.done && x.todo)); assert.equal(s.next, step(s, 'feeds').todo);
    const init = (await app.mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).result;
    assert.match(init.instructions, /get_setup_status/, 'a connecting agent is pointed at the setup check');
  } finally { done(); }
});

test('each step turns done for the right reason, and only all four make setup finished', async () => {
  const { store, app, call, step, done } = fresh();
  try {
    // The agent calling the tool is itself proof that it is connected; an admin looking does not count as the agent.
    assert.equal(step(app.setupStatus(), 'agent_connected').done, false);
    let s = await call('get_setup_status'); assert.equal(step(s, 'agent_connected').done, true); assert.equal(s.finished, false);
    assert.equal(step(app.setupStatus(), 'agent_connected').done, true, 'remembered for the owner\'s view');

    // A feed that reports in counts; one that never did does not.
    store.contact('demo', 'main', 'ok'); store.ingest('demo', [{ sourceId: 'm1', threadId: 't', author: 'a', sourceTime: new Date().toISOString(), text: 'made-up message' }]);
    store.decide(store.db.prepare('SELECT id FROM events').get().id, { bucket: 'later', stage: 'pending_agent' });
    s = await call('get_setup_status'); assert.equal(step(s, 'feeds').done, true); assert.match(step(s, 'feeds').detail, /demo/);

    // One event is not enough: both urgent and heads-up must be covered, by a subscription or by polling.
    const sub = name => app.mcp({ jsonrpc: '2.0', id: 2, method: 'events/subscribe', params: { name, delivery: { mode: 'webhook', url: 'https://agent.example/hook', secret: SECRET } } }, 'agent');
    assert.ok((await sub('urgent_item')).result.id);
    s = await call('get_setup_status'); assert.equal(step(s, 'wake_ups').done, false); assert.match(step(s, 'wake_ups').detail, /not subscribed to heads_up_item/);
    await call('get_heads_up_updates'); s = await call('get_setup_status');
    assert.equal(step(s, 'wake_ups').done, true, 'polling covers an event the agent cannot subscribe to'); assert.match(step(s, 'wake_ups').detail, /polling get_heads_up_updates/);
    assert.ok((await sub('heads_up_item')).result.id); assert.match(step(await call('get_setup_status'), 'wake_ups').detail, /subscribed to heads_up_item/);

    // Labelling: an item is waiting, so only a label finishes setup.
    assert.equal(step(s, 'labelling').done, false); assert.equal(s.finished, false);
    const items = (await call('get_items_to_label')).items; assert.equal(items.length, 1);
    await call('submit_labels', { labels: [{ id: items[0].id, bucket: 'later', reason: 'made up' }] });
    s = await call('get_setup_status'); assert.equal(s.finished, true); assert.ok(s.steps.every(x => x.done && !x.todo)); assert.match(s.next, /finished/);
  } finally { done(); }
});

test('with nothing waiting, having asked for items to label is enough; a failing subscription is not', async () => {
  const { store, app, call, step, done } = fresh();
  try {
    store.contact('demo', 'main', 'ok'); await call('get_items_to_label');
    assert.equal(step(await call('get_setup_status'), 'labelling').done, true);
    await app.mcp({ jsonrpc: '2.0', id: 2, method: 'events/subscribe', params: { name: 'urgent_item', delivery: { mode: 'webhook', url: 'https://agent.example/hook', secret: SECRET } } }, 'agent');
    store.db.prepare(`UPDATE subscriptions SET failures=3, last_error='status 500'`).run();
    const w = step(await call('get_setup_status'), 'wake_ups'); assert.equal(w.done, false); assert.match(w.detail, /failing/);
  } finally { done(); }
});
