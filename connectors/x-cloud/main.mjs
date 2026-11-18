// X capture without the owner's own browser: an ordinary Chromium on this machine, logged in to X by the owner,
// opens the home timeline every so often and forwards the timeline JSON the X web app fetches, exactly as the
// extension does. The browser only runs during a capture or while the owner is logging in.
//
// Logging in: the owner asks for a login window (POST /x-login on the core). While it is open the browser sits on
// X's login page and its remote-control port is reachable over the private network (`fly proxy 9223`), so the owner
// can type into it from their own machine. The window closes as soon as the session exists, or after 20 minutes.
// This program never sees a password and never answers a challenge from X: if X asks for one, it waits for the owner.
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';

const DATA = process.env.CLOCKWORK_X_DATA || path.join(process.env.CLOCKWORK_DATA || '/data', 'x-cloud');
const CORE = (process.env.CLOCKWORK_CORE_URL || 'http://127.0.0.1:4600').replace(/\/$/, ''), TOKEN = process.env.CLOCKWORK_INGEST_TOKEN || '';
const CHROME = process.env.CLOCKWORK_X_CHROME || '/usr/bin/chromium';
const EXTRA = (process.env.CLOCKWORK_X_CHROME_FLAGS || '').split(' ').filter(Boolean);
const DISPLAY = process.env.CLOCKWORK_X_DISPLAY ?? ':99';           // empty: use whatever display (or headless flag) the caller set up
const INTERVAL = Number(process.env.CLOCKWORK_X_INTERVAL_MIN || 30) * 60e3, SCROLLS = Number(process.env.CLOCKWORK_X_SCROLLS || 1);
const CDP_PORT = Number(process.env.CLOCKWORK_X_CDP_PORT || 9222), LOGIN_PORT = Number(process.env.CLOCKWORK_X_LOGIN_PORT || 9223), LOGIN_HOST = process.env.CLOCKWORK_X_LOGIN_HOST || '127.0.0.1', LOGIN_WINDOW = 20 * 60e3;
const FLAG = path.join(DATA, 'login-requested'), STATUS = path.join(DATA, 'status.json'), ONCE = process.argv.includes('--once');
const OPS = /\/graphql\/[^/]+\/(HomeTimeline|HomeLatestTimeline)\b/;
// On the owner's own Mac instead of a server: set CLOCKWORK_X_LOCAL_APP to the browser's app name ("Google Chrome"). It is opened
// through macOS as a separate browser with its own profile: behind other windows for a visit, in front for a login.
const LOCAL_APP = process.env.CLOCKWORK_X_LOCAL_APP || '';
// Keep one hidden browser open between visits instead of starting one each time (costs its memory all the time).
const KEEP_OPEN = process.env.CLOCKWORK_X_KEEP_OPEN === '1';
let kept = null;
const opened = new Set(); // every browser this run has open, so stopping the reader never leaves a window behind
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[x-cloud] ${m}`);

fs.mkdirSync(path.join(DATA, 'profile'), { recursive: true, mode: 0o700 });
let status = {}; try { status = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch {}
// Every change of state is also reported to the core (no content, just the state), so it can tell "nothing new" from "not running".
const ACCOUNT = process.env.CLOCKWORK_X_ACCOUNT || (process.env.CLOCKWORK_X_LOCAL_APP ? 'local' : 'cloud');
const beat = state => fetch(CORE + '/ingest/events', { method: 'POST', headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) },
  body: JSON.stringify({ source: 'x', events: [], account: ACCOUNT, status: state }), signal: AbortSignal.timeout(15000) }).catch(() => {});
const setStatus = patch => { status = { ...status, ...patch, updatedAt: new Date().toISOString() }; fs.writeFileSync(STATUS + '.tmp', JSON.stringify(status)); fs.renameSync(STATUS + '.tmp', STATUS); if (patch.state) beat(patch.state); };

class Cdp {
  constructor(ws) { this.ws = ws; this.n = 0; this.waiting = new Map(); this.handlers = new Map();
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
      if (m.id) { const w = this.waiting.get(m.id); if (!w) return; this.waiting.delete(m.id); clearTimeout(w.timer); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
      else for (const h of this.handlers.get(m.method) || []) h(m.params); }); }
  send(method, params = {}) { const id = ++this.n; return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('timed out: ' + method)); }, 30000);
    this.waiting.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(method, h) { this.handlers.set(method, [...(this.handlers.get(method) || []), h]); }
}

const answering = async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
async function openBrowser(url, { foreground = false } = {}) {
  const args = [`--user-data-dir=${path.join(DATA, 'profile')}`, `--remote-debugging-port=${CDP_PORT}`,
    `--remote-allow-origins=http://localhost:${LOGIN_PORT},http://127.0.0.1:${LOGIN_PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
    '--password-store=basic', '--window-size=1280,900', '--disable-background-networking', ...EXTRA, 'about:blank'];
  let exited = false, child = null;
  if (LOCAL_APP && await answering()) { /* one is already open (kept from before, or left by an earlier run): use it */ }
  else if (LOCAL_APP) {
    // A page behind other windows must keep loading and scrolling, so the browser is told not to pause hidden pages.
    spawn('open', [foreground ? '-n' : '-gjn', '-a', LOCAL_APP,   // -g: do not come to the front; -j: start hidden, so no window appears at all
      '--args', ...args, ...(foreground ? [] : ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'])], { stdio: 'ignore' });
  } else {
    child = spawn(CHROME, args, { stdio: 'ignore', env: { ...process.env, ...(DISPLAY ? { DISPLAY } : {}) } });
    child.on('exit', () => { exited = true; });
  }
  const kill = async () => { if (child) child.kill('SIGKILL'); };
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500); if (exited) throw new Error('the browser did not start');
    try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
  }
  if (!target) { await kill(); throw new Error('the browser did not answer'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('could not attach to the browser'))); });
  const cdp = new Cdp(ws);
  await cdp.send('Network.enable'); await cdp.send('Page.enable');
  ws.addEventListener('close', () => { if (!child) exited = true; }); // opened through macOS: the connection is how we know it is still there
  const close = async () => { try { await cdp.send('Browser.close'); } catch {} for (let i = 0; i < 20 && (child ? !exited : await answering()); i++) await sleep(250); if (child && !exited) await kill(); };
  if (LOCAL_APP && !foreground) {
    // macOS does not reliably start this browser hidden, so its window is minimized through the browser itself:
    // nothing stays on screen, and no system permission is needed.
    try { const w = await cdp.send('Browser.getWindowForTarget'); await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } }); } catch (e) { log('could not minimize the browser window: ' + e.message); }
    // A hidden window draws nothing, and X only loads more posts when the page is actually drawn. Asking the browser for a
    // low-rate picture of the page keeps it drawing. The pictures are discarded.
    cdp.on('Page.screencastFrame', p => { cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {}); });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 10, maxWidth: 320, maxHeight: 225, everyNthFrame: 6 }).catch(() => {});
  }
  if (url) await cdp.send('Page.navigate', { url });
  const b = { cdp, close: async () => { opened.delete(b); await close(); }, alive: () => !exited }; opened.add(b); return b;
}
// Whether a session exists is read from the presence of X's session cookie; its value is never read or logged.
const loggedIn = async cdp => (await cdp.send('Network.getCookies', { urls: ['https://x.com'] })).cookies.some(c => c.name === 'auth_token' && c.value);
const evaluate = async (cdp, expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;

async function forward(operation, text) {
  let json; try { json = JSON.parse(text); } catch { return 0; }
  const r = await fetch(CORE + '/ingest/x-raw', { method: 'POST', headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) },
    body: JSON.stringify({ operation, capturedAt: new Date().toISOString(), json }) });
  if (!r.ok) throw new Error('core answered ' + r.status);
  return (await r.json()).new ?? 0;
}

/** One visit: open the home timeline, read a few screens of each tab, forward what the page fetched. */
async function capture() {
  const b = kept?.alive() ? kept : await openBrowser(); kept = null; const { cdp } = b; const wanted = new Map(); const jobs = []; let responses = 0, fresh = 0, keep = false;
  for (const m of ['Network.responseReceived', 'Network.loadingFinished', 'Network.requestWillBeSent']) cdp.handlers.delete(m); // a kept browser still has last visit's listeners
  try {
    const seen = {}; const DEBUG = process.env.CLOCKWORK_X_DEBUG === '1';
    if (DEBUG) cdp.on('Network.requestWillBeSent', p => { const m = /\/graphql\/[^/]+\/(\w+)/.exec(p.request.url); if (m) seen[m[1]] = (seen[m[1]] || 0) + 1; });
    cdp.on('Network.responseReceived', p => { const m = OPS.exec(p.response.url); if (m && p.response.status === 200) wanted.set(p.requestId, m[1]); });
    cdp.on('Network.loadingFinished', p => { const op = wanted.get(p.requestId); if (!op) return; wanted.delete(p.requestId);
      jobs.push((async () => { const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
        fresh += await forward(op, body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body); responses++; })().catch(e => log('forward failed: ' + e.message))); });
    if (!(await loggedIn(cdp))) return { state: 'needs_login' }; // checked before touching X: without a session there is nothing to visit
    await cdp.send('Page.navigate', { url: 'https://x.com/home' }); await sleep(9000);
    if (!(await loggedIn(cdp))) return { state: 'needs_login' };
    const href = String(await evaluate(cdp, 'location.href'));
    if (!/^https:\/\/x\.com\/home/.test(href)) return { state: 'blocked', detail: 'X sent the browser somewhere other than the home timeline; it may be asking for a check' };
    // X loads the next batch of posts only when the bottom of the page comes into view, and the first batch is many screens
    // tall, so each step goes to the bottom: one step = one more batch.
    const readScreen = async () => { for (let i = 0; i < SCROLLS; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 450, deltaX: 0, deltaY: 2600 }).catch(() => {}); await sleep(600 + Math.random() * 600);
      await evaluate(cdp, 'window.scrollTo(0, document.documentElement.scrollHeight)'); await sleep(3500 + Math.random() * 2500); } };
    await readScreen();
    // The other of the two home tabs ("For you" / "Following"), whichever was not showing.
    if (await evaluate(cdp, `(() => { const t = [...document.querySelectorAll('[role="tablist"] [role="tab"]')].slice(0, 2).find(x => x.getAttribute('aria-selected') === 'false'); if (!t) return false; t.click(); return true; })()`)) { await sleep(6000); await readScreen(); }
    if (DEBUG) log('debug ' + JSON.stringify({ seen, page: await evaluate(cdp, `({ y: Math.round(scrollY), h: document.documentElement.scrollHeight, vis: document.visibilityState, focus: document.hasFocus(), articles: document.querySelectorAll('article').length, inner: [innerWidth, innerHeight] })`) }));
    await sleep(1500); await Promise.all(jobs);
    keep = KEEP_OPEN && responses > 0;
    return responses ? { state: 'ok', responses, fresh } : { state: 'blocked', detail: 'the home page loaded but no timeline arrived' };
  } finally { if (keep && b.alive()) { kept = b; await cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => {}); } else await b.close(); } // parked on a blank page between visits
}

/** Keep the browser on X's login page, reachable by the owner over the private network, until a session exists. */
async function loginWindow() {
  if (kept) { await kept.close(); kept = null; }
  if (LOCAL_APP && await answering()) throw new Error('close the hidden capture browser first');
  const b = await openBrowser('https://x.com/login', { foreground: true }); const sockets = new Set();
  const relay = net.createServer(s => { const up = net.connect(CDP_PORT, '127.0.0.1'); sockets.add(s); sockets.add(up);
    s.pipe(up).pipe(s); const end = () => { s.destroy(); up.destroy(); sockets.delete(s); sockets.delete(up); }; s.on('error', end); up.on('error', end); s.on('close', end); up.on('close', end); });
  // On the owner's own machine the browser window is right in front of them; the relay is only for a remote instance.
  if (!LOCAL_APP) await new Promise((resolve, reject) => { relay.on('error', reject); relay.listen(LOGIN_PORT, LOGIN_HOST, resolve); });
  const until = Date.now() + LOGIN_WINDOW; setStatus({ state: 'login_window_open', loginWindowUntil: new Date(until).toISOString(), detail: undefined });
  log('login window open'); let ok = false;
  try { while (Date.now() < until && b.alive() && fs.existsSync(FLAG) && !(ok = await loggedIn(b.cdp).catch(() => false))) await sleep(3000); if (ok) await sleep(8000); /* let X finish its redirects and the profile settle */ }
  finally { for (const s of sockets) s.destroy(); if (relay.listening) relay.close(); await b.close(); fs.rmSync(FLAG, { force: true }); }
  log(ok ? 'logged in; login window closed' : 'login window closed without a session');
  setStatus({ state: ok ? 'logged_in' : 'needs_login', loginWindowUntil: undefined });
  return ok;
}

let xvfb = null;
function display() { // an ordinary (not headless) browser needs a screen to draw on, even an invisible one
  if (!DISPLAY || xvfb || LOCAL_APP) return;
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  xvfb.on('exit', () => { xvfb = null; });
}

async function main() {
  display(); await sleep(DISPLAY && !LOCAL_APP ? 1500 : 0);
  for (;;) {
    let wait = INTERVAL * (0.8 + Math.random() * 0.4);
    try {
      if (fs.existsSync(FLAG)) { if (await loginWindow()) wait = 5000; }
      else {
        const r = await capture();
        if (r.state === 'ok') { setStatus({ state: 'ok', lastCapture: new Date().toISOString(), lastResponses: r.responses, lastNew: r.fresh, detail: undefined }); log(`captured ${r.responses} timeline responses, ${r.fresh} new posts`); }
        else { setStatus({ state: r.state, detail: r.detail }); log(r.state + (r.detail ? ': ' + r.detail : '')); if (r.state === 'blocked') wait = Math.max(wait, 2 * 3600e3); } // never hammer X when it objects
      }
    } catch (e) { setStatus({ state: 'error', detail: e.message }); log('error: ' + e.message); }
    if (ONCE) break;
    // Sleep in short steps so a requested login window opens promptly.
    for (const end = Date.now() + wait; Date.now() < end && !(fs.existsSync(FLAG) && status.state !== 'login_window_open');) await sleep(5000);
  }
  if (kept) await kept.close();
  xvfb?.kill();
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await Promise.all([...opened].map(b => b.close())); } finally { xvfb?.kill(); process.exit(0); } });
main();
