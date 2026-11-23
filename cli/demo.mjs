// `clockwork demo`: a throwaway Clockwork fed with made-up messages, so an agent can be connected, taught and woken before
// any real account is linked. It has its own folder, port and tokens, and never reads or writes the real install.
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const flag = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
// Every name and message here is invented. One sender, "School office", matches the demo heads-up rule.
const SCHOOL = 'School office';
const MESSAGES = [
  ['Riverside Book Club', 'Next month we are reading a detective novel. Votes for the one after that are open until Friday.'],
  ['Parcel Updates', 'Your parcel is out for delivery today between 2 and 4 pm.'],
  [SCHOOL, 'Pickup is one hour earlier today because of the staff meeting. Please confirm who is collecting.'],
  ['Mega Deals', 'Flash sale! 40% off everything until midnight. Do not miss out.'],
  ['Jo Tester', 'Are we still on for lunch on Thursday? I can do 12:30.'],
  ['Building Notices', 'The water will be shut off on Wednesday from 9 to 11 am for maintenance.'],
  ['Weekly Digest', 'Ten articles you might have missed this week.'],
  [SCHOOL, 'A reminder that the permission form for the museum trip is due tomorrow morning.'],
  ['Sam Example', 'I pushed the draft of the budget. Can you look at section 3 before the call at 4?'],
  ['Gym Membership', 'Your membership renews next month. No action is needed.'],
  ['Alex Placeholder', 'Happy birthday for next week! Any plans?'],
  [SCHOOL, 'The after-school club is cancelled this afternoon. Children need to be collected at the normal time.'],
  ['Dentist Reception', 'We had a cancellation: there is a slot tomorrow at 10:15 if you want it. Reply by 5 pm today.'],
  ['Newsletter', 'Our spring catalogue is here. Browse the new collection.'],
];

export async function demo() {
  const dir = process.env.CLOCKWORK_DEMO_DATA || path.join(os.homedir(), '.clockwork', 'demo');
  if (process.argv.includes('--reset')) fs.rmSync(dir, { recursive: true, force: true });
  process.env.CLOCKWORK_DATA = dir; // before the first use of the shared paths, so nothing below can touch the real install
  const lib = await import('./lib.mjs');
  if (!fs.existsSync(path.join(lib.ROOT, 'core', 'node_modules'))) { console.error('The core dependencies are missing. Run ./install.sh first.'); process.exit(1); }
  const { config: c } = lib.initConfig(); const every = Math.max(1, Number(flag('every', 45)) || 45), pub = flag('public', '');
  c.port = Number(process.env.CLOCKWORK_DEMO_PORT || 4610); c.studentPort = c.port + 1; c.teacherMode = 'agent';
  if (pub) { if (!/^https:\/\//.test(pub)) { console.error('--public must be an https address (your tunnel).'); process.exit(1); } c.publicUrl = pub.replace(/\/+$/, ''); } else delete c.publicUrl;
  lib.saveConfig(c);
  const base = lib.coreUrl(c), log = fs.openSync(path.join(dir, 'core.log'), 'a');
  const core = spawn(process.execPath, ['server.mjs'], { cwd: path.join(lib.ROOT, 'core'), env: lib.coreEnv(c), stdio: ['ignore', log, log] });
  const stop = () => { try { core.kill('SIGTERM'); } catch {} process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); core.on('exit', code => { console.error(`The demo core stopped (${code}). See ${path.join(dir, 'core.log')}; is port ${c.port} in use?`); process.exit(1); });
  const call = (role, method, pathname, body) => fetch(base + pathname, { method, headers: { authorization: 'Bearer ' + c.tokens[role], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) }).then(r => r.json());
  for (let i = 0; ; i++) { if (await fetch(base + '/health', { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)) break; if (i > 40) { console.error('The demo core did not start.'); stop(); } await new Promise(r => setTimeout(r, 250)); }
  await call('admin', 'PUT', '/heads-up-rules', { rules: [{ name: 'School office (demo)', why: 'pickup and timetable changes', senderContains: ['school office'] }] });

  let n = Number(fs.existsSync(path.join(dir, 'sent')) ? fs.readFileSync(path.join(dir, 'sent'), 'utf8') : 0) || 0;
  const send = async count => {
    const events = []; for (let k = 0; k < count; k++, n++) { const [who, text] = MESSAGES[n % MESSAGES.length], id = who.toLowerCase().replace(/[^a-z]+/g, '-');
      // A new conversation each time for the school, because a conversation wakes the agent at most once an hour.
      events.push({ sourceId: `m${n}`, threadId: who === SCHOOL ? `${id}-${n}` : id, author: id, authorName: who, chatName: who, sourceTime: new Date().toISOString(), text }); }
    await call('ingest', 'POST', '/ingest/events', { source: 'demo', account: 'made-up', status: 'ok', events }); fs.writeFileSync(path.join(dir, 'sent'), String(n));
    return events;
  };

  console.log(`Clockwork demo: a throwaway copy fed with made-up messages. Your real Clockwork and your accounts are not touched.

  address   ${c.publicUrl ? `${c.publicUrl}/mcp (sign in with OAuth; approve with the admin token in ${lib.paths.config()})` : `${base}/mcp`}
  token     in ${lib.paths.agentToken()} (send it as "Authorization: Bearer <token>")
  skill     ${path.join(lib.ROOT, 'agent', 'SKILL.md')}

Connect your agent, give it the skill file, and have it call get_setup_status and do what it says.
A made-up message arrives every ${every} s. Those from "${SCHOOL}" match a heads-up rule and wake an agent that
subscribed to heads_up_item. There is no local model in the demo, so every message goes to your agent to label.${c.publicUrl ? '' : `
An agent in a vendor's cloud cannot reach 127.0.0.1: put a tunnel in front of port ${c.port} and run clockwork demo --public=<its https address>.`}
Ctrl-C stops it. "clockwork demo --reset" starts again from empty. To remove it, delete ${dir}
`);
  const stamp = () => new Date().toTimeString().slice(0, 8); let was = {};
  const report = async () => { const s = await call('admin', 'GET', '/setup').catch(() => null); if (!s) return;
    for (const x of s.steps) if (x.done !== was[x.step]) { if (x.done || was[x.step] !== undefined) console.log(`${stamp()}  ${x.done ? 'done' : 'undone'}: ${x.step.replace('_', ' ')} (${x.detail})`); was[x.step] = x.done; }
    if (s.finished && !was.finished) console.log(`${stamp()}  Setup is finished: your agent is connected, has its wake-ups arranged, and is labelling.`); was.finished = s.finished; };
  await send(n ? 1 : 5); console.log(`${stamp()}  ${n} made-up message(s) so far`); await report();
  for (;;) { await new Promise(r => setTimeout(r, every * 1000)); const [e] = await send(1).catch(() => [null]); if (e) console.log(`${stamp()}  new message from "${e.authorName}"${e.authorName === SCHOOL ? ' (matches the heads-up rule)' : ''}`); await report(); }
}
