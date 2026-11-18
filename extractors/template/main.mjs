// A minimal Clockwork extractor. It needs nothing but Node. The whole contract is in docs/EXTRACTORS.md:
// post items to the core with the write-only token Clockwork puts in this program's environment. It can never read items back.
import fs from 'node:fs'; import path from 'node:path';

const CORE = process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600';
const TOKEN = process.env.CLOCKWORK_INGEST_TOKEN || '';
const DATA = process.env.CLOCKWORK_EXTRACTOR_DATA || '.';       // a private folder for this extractor's own state
const SOURCE = JSON.parse(fs.readFileSync(new URL('./extractor.json', import.meta.url), 'utf8')).source;
const ONCE = process.argv.includes('--once');

async function send(events, status = 'ok') {
  const r = await fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ source: SOURCE, events, status }) });
  if (!r.ok) throw new Error(`core answered ${r.status}`);
  return r.json();                                               // { received, new }: items already sent before are not counted as new
}

/** Replace this: return the items that are new since `state`, and the state to remember for next time. */
async function fetchNew(state) {
  const now = new Date().toISOString();
  const items = state.sentHello ? [] : [{
    sourceId: 'hello-1',                       // required: stable id of the item at its origin. The same id is never stored twice.
    threadId: 'welcome',                       // the conversation it belongs to; items in one thread are shown to the model together
    author: 'template@example.invalid',        // a stable sender id
    authorName: 'Template extractor',          // how the sender is shown
    sourceTime: now,                           // when it was sent, ISO 8601
    direction: 'incoming',                     // 'outgoing' for things the user wrote themself: never triaged, but used as context
    isGroup: false,
    kind: 'text',                              // 'image', 'video', 'audio', 'document' when there is content Clockwork cannot read
    text: 'Hello from your new extractor.',
    url: undefined,                            // where to open the item, if it has an address
    chatName: undefined,                       // the name of the group or channel, if any
  }];
  return { items, state: { ...state, sentHello: true } };
}

const stateFile = path.join(DATA, 'state.json');
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
for (;;) {
  try {
    const { items, state } = await fetchNew(load());
    const res = await send(items);             // an empty list is a heartbeat: "running, nothing new"
    fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state));   // only after the core has the items
    if (items.length) console.log(`sent ${items.length}, ${res.new} new`);
  } catch (e) { console.error('failed:', e.message); await send([], 'error').catch(() => {}); }
  if (ONCE) break;
  await new Promise(r => setTimeout(r, 60_000));
}
