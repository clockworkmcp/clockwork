#!/usr/bin/env node
// The `clockwork` command: set up, run and inspect one local Clockwork instance, and manage its extractors.
import { spawn, spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import readline from 'node:readline/promises';
import { ROOT, LABEL, NAME, paths, dataDir, loadConfig, saveConfig, initConfig, coreUrl, listExtractors, findExtractor, resolveExtractor, manifestProblems,
  plist, plistPath, readState, supervisorAlive, python, writePrivate, version, commitOf, upgradeState, applyUpgrade } from './lib.mjs';
import { getSecret, setSecret, deleteSecret, secretsFor, legacyValue, hostVar, backend, backendName, tighten } from './secrets.mjs';

const HELP = `clockwork: personal feed triage that runs on your own machine

  clockwork init                 create the config and access tokens (safe to repeat)
  clockwork start | stop         run in the background and at login | stop
  clockwork run                  run in this terminal instead
  clockwork status               what is running, what each source last saw, how training is going
  clockwork logs <name>          recent output of one part (core, scorer, trainer or an extractor)
  clockwork doctor               check that everything needed is installed
  clockwork version              which version this is
  clockwork upgrade [--check]    fetch the newest Clockwork and restart (shows what is new and asks first)
  clockwork demo                 a throwaway copy with made-up messages, to try with your agent before linking any account

  clockwork extractors           list extractors and whether each is on
  clockwork connect <name>       switch an extractor on and link its account (whatsapp, gmail, x, ...). Asks for any key
                                 it needs and keeps it in your Keychain; --replace to enter a new one
  clockwork enable|disable <name>
  clockwork add <folder|git-url> add an extractor someone else wrote (shows what it will run and asks first)
  clockwork update <name> [ref]  fetch a newer version of an added extractor (asks first; never happens by itself)
  clockwork new <name> [kind]    start your own extractor from a template (kinds: basic, api, mac-app)
  clockwork check <name|folder>  validate an extractor, give it one trial run that touches none of your items,
                                 and run it offline over the sample input in its fixtures/ folder
  clockwork remove <name>        delete an added extractor

  clockwork agent                how to connect your agent, and where its instructions are
  clockwork train                retrain the local model now
`;
const die = m => { console.error(m); process.exit(1); };
const need = () => loadConfig() || die('Not set up yet. Run: clockwork init');
const api = async (c, pathname, body) => {
  const r = await fetch(coreUrl(c) + pathname, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + c.tokens.admin, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${pathname}: ${r.status}`); return r.json();
};
const ask = async q => { if (process.argv.includes('--yes')) return true; if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question(q + ' [y/N] '); rl.close(); return /^y(es)?$/i.test(a.trim()); };
/** One answer typed by the user. A key is not shown as it is typed. When nobody is at a terminal, lines piped in are used in order. */
let piped = null;
async function askValue(q, hidden) {
  if (!process.stdin.isTTY) { if (piped === null) { let s = ''; for await (const d of process.stdin) s += d; piped = s.split(/\r?\n/); } return (piped.shift() || '').trim(); }
  if (!hidden) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question(q); rl.close(); return a.trim(); }
  process.stdout.write(q); process.stdin.setRawMode(true); process.stdin.resume(); let v = '';
  return new Promise(ok => { const done = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', on); process.stdout.write('\n'); };
    const on = d => { for (const ch of d.toString('utf8')) {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { done(); return ok(v.trim()); }
      if (ch === '\u0003') { done(); process.exit(130); }
      if (ch === '\u007f' || ch === '\b') v = v.slice(0, -1); else if (ch >= ' ') v += ch; } };
    process.stdin.on('data', on); });
}
/** Ask for the keys an extractor needs that are not saved yet, and keep them where keys belong (cli/secrets.mjs). Never printed. */
async function collectSecrets(name, secrets) {
  const replace = process.argv.includes('--replace');
  for (const s of secrets) {
    const have = getSecret(name, s.name), old = s.file && legacyValue(s.file);
    if (process.env[hostVar(name, s.name)]) { console.log(`${s.prompt}: set by this machine's own secret store (${hostVar(name, s.name)}).`); continue; }
    if (old && !have && backend() === 'keychain' && !replace) { setSecret(name, s.name, old); fs.rmSync(s.file, { force: true }); console.log(`${s.prompt}: moved out of ${s.file} into ${backendName()}. The file is deleted.`); continue; }
    if ((have || old) && !replace) { console.log(`${s.prompt}: already saved. To enter a new one: clockwork connect ${name} --replace`); continue; }
    if (s.help) console.log(s.help);
    const v = await askValue(`${s.prompt}${s.hidden === false ? '' : ' (not shown as you type or paste)'}: `, s.hidden !== false);
    if (!v && s.optional) { console.log(`${s.prompt}: none saved. It works without one; to add one later: clockwork connect ${name} --replace`); continue; }
    if (!v) die(`Nothing was entered for "${s.prompt}". Linking asks for a key to your account, so run this yourself in a terminal: clockwork connect ${name}\nDo not give it to an agent or paste it into a chat.`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) die(`That is not shaped like ${/^[aeiou]/i.test(s.prompt) ? 'an' : 'a'} ${s.prompt}, so nothing was saved.`);
    try { setSecret(name, s.name, v); } catch (e) { die(`Could not save it: ${e.message}`); }
    if (old) fs.rmSync(s.file, { force: true });
    console.log(`Saved in ${backendName()}.`);
  }
}
const runHere = (c, env, cwd) => spawnSync(c.command, c.args, { cwd, env, stdio: 'inherit' }).status === 0;
const ago = t => { if (!t) return 'never'; const s = (Date.now() - new Date(t)) / 1000; return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const table = rows => { const w = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i] ?? '').length))); for (const r of rows) console.log('  ' + r.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ').trimEnd()); };
const restartHint = () => { if (supervisorAlive()) console.log('The running service picks this up within a few seconds.'); };
const launchctl = (...a) => spawnSync('launchctl', a, { encoding: 'utf8' });
const domain = () => `gui/${os.userInfo().uid}`;

// ---- extractors from elsewhere: fetch, show exactly what will run, and only then copy -------------------------------
const isGit = s => /^(https:\/\/|git@|ssh:\/\/|file:\/\/)/.test(s);
/** A local folder as it is, or a git address (optionally `address#tag-or-commit`) fetched into a temporary folder. */
function obtain(src) {
  if (!isGit(src)) return { dir: path.resolve(src), commit: null, tmp: null };
  const [url, ref] = src.split('#'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-add-')), dir = path.join(tmp, 'x'), git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
  fs.mkdirSync(dir);
  if (git('-C', dir, 'init', '-q').status !== 0 || git('-C', dir, 'fetch', '-q', '--depth', '1', '--', url, ref || 'HEAD').status !== 0 || git('-C', dir, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD').status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); die(`Could not fetch ${ref ? `"${ref}" from ` : ''}that address.`); }
  return { dir, commit: git('-C', dir, 'rev-parse', 'HEAD').stdout.trim(), tmp };
}
function reviewed(got, src) {
  let m; try { m = JSON.parse(fs.readFileSync(path.join(got.dir, 'extractor.json'), 'utf8')); } catch { die(`No readable extractor.json in ${src}`); }
  const problems = manifestProblems(m); if (m.cwd !== undefined) problems.push('"cwd" is only for built-in extractors');
  if (problems.length) die(`That extractor cannot be added:\n  - ${problems.join('\n  - ')}`);
  return m;
}
function describe(m, src, commit, was) {
  const show = k => m[k] ? `${m[k].command} ${(m[k].args || []).join(' ')}` : '(nothing)';
  console.log(`\nExtractor "${m.name}" for source "${m.source}"${m.description ? `: ${String(m.description).slice(0, 200)}` : ''}\n  from     ${src}${commit ? `\n  version  ${commit}${was ? ` (you have ${was.slice(0, 12)})` : ''}` : ''}\n  installs ${show('install')}\n  builds   ${show('build')}\n  runs     ${show('run')}`);
  console.log('\nNobody at Clockwork has reviewed this. It is code from outside that will run as you, every time Clockwork runs, and can do\nanything you can do on this machine, including reading the accounts you link to it. It gets a write-only token for Clockwork:\nit can add items, not read yours. It is never updated unless you ask. Only add it if you trust where it came from.\n');
}
function place(got, m, src) {
  const dest = path.join(paths.userExtractors(), m.name); fs.mkdirSync(paths.userExtractors(), { recursive: true, mode: 0o700 });
  fs.cpSync(got.dir, dest, { recursive: true, filter: p => !/(^|\/)(\.git|node_modules)(\/|$)/.test(path.relative(got.dir, p)) });
  writePrivate(path.join(dest, '.added.json'), JSON.stringify({ from: src.split('#')[0], commit: got.commit, at: new Date().toISOString() }));
}
const addedInfo = x => { try { return JSON.parse(fs.readFileSync(path.join(x.dir, '.added.json'), 'utf8')); } catch { return null; } };

// ---- check: a stand-in for the core, and runs of an extractor against it --------------------------------------------
/** Records what one run of an extractor sends and holds every item against the contract. Nothing reaches the real core. */
async function standIn(m) {
  const http = await import('node:http'), crypto = await import('node:crypto'), token = crypto.randomBytes(16).toString('hex');
  const seen = { posts: 0, items: 0, at: 0, other: new Set(), status: new Set(), bad: new Set(), notes: new Set() };
  const server = http.createServer((req, res) => { let body = ''; req.on('data', d => { body += d; if (body.length > 9e6) req.destroy(); }); req.on('end', () => {
    if (req.method !== 'POST' || req.url !== '/ingest/events') { seen.other.add(`${req.method} ${req.url}`); res.writeHead(403); return res.end('{}'); }
    if (req.headers.authorization !== 'Bearer ' + token) seen.bad.add('a request came without the token from CLOCKWORK_INGEST_TOKEN');
    let j = null; try { j = JSON.parse(body); } catch { seen.bad.add('a request body was not JSON'); }
    if (j) { seen.posts++; seen.at = Date.now(); if (j.source !== m.source) seen.bad.add(`"source" was ${JSON.stringify(j.source)}; the manifest says "${m.source}"`);
      if (!Array.isArray(j.events)) seen.bad.add('"events" was not a list'); else for (const e of j.events) { seen.items++;
        if (typeof e?.sourceId !== 'string' || !e.sourceId) seen.bad.add('an item has no "sourceId"');
        if (e?.direction !== undefined && !['incoming', 'outgoing'].includes(e.direction)) seen.bad.add(`"direction" was ${JSON.stringify(e.direction)}`);
        if (e?.sourceTime !== undefined && Number.isNaN(Date.parse(e.sourceTime))) seen.bad.add(`"sourceTime" ${JSON.stringify(e.sourceTime)} is not a date`);
        if (e?.text !== undefined && typeof e.text !== 'string') seen.bad.add('"text" was not a string');
        if (e?.sourceTime === undefined) seen.notes.add('items have no "sourceTime": queues are ordered by it'); }
      if (typeof j.status === 'string') seen.status.add(j.status); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j?.events?.length || 0, new: j?.events?.length || 0 })); }); });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return { seen, token, url: `http://127.0.0.1:${server.address().port}`, close() { server.close(); server.closeAllConnections?.(); } };
}
/** Run the program against a stand-in with a throwaway data folder, until `done(seen, ms)` says so, it stops, or time is up. */
async function trial(m, r, { seconds, env = {}, done }) {
  const core = await standIn(m), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-check-')), start = Date.now();
  const child = spawn(r.run.command, r.run.args, { cwd: r.cwd, detached: true, stdio: 'ignore', env: { ...r.env, ...env, CLOCKWORK_CORE_URL: core.url, CLOCKWORK_INGEST_TOKEN: core.token, CLOCKWORK_EXTRACTOR_DATA: tmp } });
  let failed = null, exited = false; child.on('error', e => { failed = e.message; }); child.on('exit', () => { exited = true; });
  while (Date.now() < start + seconds * 1000 && !failed && !exited && !done(core.seen, Date.now() - start)) await new Promise(ok => setTimeout(ok, 100));
  try { process.kill(-child.pid, 'SIGTERM'); } catch {} core.close(); fs.rmSync(tmp, { recursive: true, force: true });
  return { ...core.seen, failed };
}
/** The sample input an extractor ships in its `fixtures/` folder: plain files, made up, small. */
const fixtureFiles = dir => { try { return fs.readdirSync(dir).filter(f => !f.startsWith('.') && fs.statSync(path.join(dir, f)).isFile()).sort(); } catch { return []; } };
/** Two ways a file from outside goes wrong: it stops half way, or it is not what its name says. */
const SPOIL = { 'cut short': b => b.subarray(0, Math.floor(b.length / 2)), 'unreadable': () => Buffer.from([0, 255, 254, 0, 123, 34, 60, 0, 255, 10, 13, 0]) };
/**
 * Run the program offline over its fixtures: once as they are, then once for each file in each damaged form.
 * `CLOCKWORK_FIXTURES` names a copy of the folder; with it set the program reads that instead of its real source.
 */
async function fixtureRuns(m, r, dir, files, say) {
  const quiet = s => s.posts && Date.now() - s.at > 700;        // it reported in, and has had a moment to send what else it has
  const run = async spoil => { const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-fixtures-')); fs.cpSync(dir, copy, { recursive: true });
    if (spoil) fs.writeFileSync(path.join(copy, spoil.file), SPOIL[spoil.how](fs.readFileSync(path.join(dir, spoil.file))));
    try { return await trial(m, r, { seconds: 15, env: { CLOCKWORK_FIXTURES: copy }, done: (s, ms) => quiet(s) && (s.items > 0 || !!spoil || ms > 5000) }); } finally { fs.rmSync(copy, { recursive: true, force: true }); } };
  const whole = await run(null);
  say(!whole.failed && whole.items > 0 && !whole.bad.size, whole.failed ? `fixtures: could not start: ${whole.failed}` : !whole.items ? 'fixtures: no item came out of the sample input (with CLOCKWORK_FIXTURES set, the program must read that folder instead of its real source)'
    : whole.bad.size ? `fixtures: the sample input gave something the core would refuse: ${[...whole.bad].join('; ')}` : `fixtures: ${files.length} file(s) of sample input read offline, ${whole.items} item(s), all well formed`);
  if (whole.failed || !whole.items) return;
  const broke = [];
  for (const file of files.slice(0, 12)) for (const how of Object.keys(SPOIL)) { const res = await run({ file, how });
    if (!res.posts) broke.push(`fixtures: with ${file} ${how} it stopped without a word. It must still report in (an empty list with status "error") and carry on`);
    else if (res.bad.size) broke.push(`fixtures: with ${file} ${how} it sent something the core would refuse: ${[...res.bad].join('; ')}`); }
  if (broke.length) for (const b of broke) say(false, b); else say(true, `fixtures: still reports in, and sends nothing malformed, with each file cut short or unreadable`);
}
/** The starting points `clockwork new` offers, by how the source is reached. */
const KINDS = { basic: 'the smallest working extractor; start here when nothing below fits', api: 'a service read through its API, with a key that is asked for and kept in the Keychain', 'mac-app': 'another app\'s own store on this Mac (a SQLite file), opened read-only' };

const commands = {
  async init() {
    const { config, created } = initConfig();
    console.log(created ? `Created ${paths.config()} with fresh access tokens (not shown; only you can read the file).` : `Already set up: ${paths.config()}`);
    console.log(`Timezone ${config.tz}. Labels come from ${config.teacherMode === 'agent' ? 'your agent' : 'the built-in teacher'}.`);
    console.log('Next: clockwork start, then clockwork connect whatsapp (clockwork extractors lists the other sources), then clockwork agent.');
  },
  async run() { const { supervise } = await import('./supervisor.mjs'); need(); await supervise(); },
  async start() {
    need(); if (supervisorAlive()) return console.log('Already running. See: clockwork status');
    if (process.platform !== 'darwin') return console.log('Starting at login is set up for macOS only so far. Here, keep `clockwork run` going with your own service manager (systemd, tmux).');
    fs.mkdirSync(paths.logs(), { recursive: true, mode: 0o700 }); fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), plist()); launchctl('bootout', `${domain()}/${LABEL}`);
    const r = launchctl('bootstrap', domain(), plistPath()); if (r.status !== 0) die(`launchd would not start it: ${r.stderr.trim()}`);
    console.log('Started. It will also start whenever you log in. See: clockwork status');
  },
  async stop() {
    if (process.platform === 'darwin' && fs.existsSync(plistPath())) { launchctl('bootout', `${domain()}/${LABEL}`); fs.rmSync(plistPath(), { force: true }); }
    const pid = supervisorAlive(); if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
    console.log(pid ? 'Stopped. It will not start at login until you run clockwork start again.' : 'It was not running.');
  },
  async status() {
    const c = need(), st = readState(), alive = supervisorAlive();
    console.log(alive ? `Running since ${ago(st?.startedAt)} (${coreUrl(c)})` : 'Not running. Start it with: clockwork start');
    if (st && alive) { console.log('\nParts'); table([['name', 'kind', 'state', 'since'], ...Object.entries(st.processes).map(([n, p]) => [n, p.kind, p.state + (p.last && p.state !== 'running' ? ` (${p.last})` : ''), ago(p.since)])]); }
    if (!alive) return;
    try {
      const src = (await api(c, '/sources')).sources || {}, tr = await api(c, '/training');
      if (Object.keys(src).length) { console.log('\nSources'); table([['source', 'state', 'last new item'], ...Object.entries(src).map(([s, v]) => [s, v.status, ago(v.lastNewItem)])]); }
      else console.log('\nNo source has reported in yet. Link one with: clockwork connect whatsapp');
      const rows = Object.entries(tr.sources || {}).map(([s, v]) => { const n = Object.values(v.labels || {}).reduce((x, y) => x + y, 0), m = v.localModel, live = v.liveCheck;
        return [s, n, v.waitingForLabel, typeof m === 'string' ? m : `agrees ${Math.round((m.heldOutAgreement ?? 0) * 100)}% on held-out labels`,
          live ? (live.decidesAlone ? 'decides what it is sure of' : `shadow: ${live.confidentPredictions} of ${live.needed.confidentPredictions} confident calls checked${live.agreement == null ? '' : `, ${Math.round(live.agreement * 100)}% matched (needs ${Math.round(live.needed.agreement * 100)}%)`}`) : '']; });
      const setup = await api(c, '/setup').catch(() => null);
      if (setup) { console.log(`\nSetup ${setup.finished ? 'is finished' : 'is NOT finished'}`); table(setup.steps.map(s => [s.done ? 'ok  ' : 'TODO', s.step.replace('_', ' '), s.detail]));
        if (!setup.finished) console.log(`  Next (for your agent): ${setup.next}`); }
      if (rows.length) { console.log(`\nTraining (labels from ${tr.teacher === 'agent' ? 'your agent' : 'the built-in teacher'}; a source needs ${tr.labelsNeededPerSource} to train)`); table([['source', 'labels', 'waiting', 'local model', 'mode'], ...rows]); }
    } catch (e) { console.log(`\nThe core is not answering yet (${e.message}). See: clockwork logs core`); }
  },
  async logs(name) {
    if (!name) die('Which part? For example: clockwork logs core'); const f = path.join(paths.logs(), path.basename(name) + '.log');
    if (!fs.existsSync(f)) die(`No log for "${name}" yet.`); const t = fs.readFileSync(f, 'utf8').split('\n'); console.log(t.slice(-80).join('\n'));
  },
  async doctor() {
    const c = loadConfig(); let bad = 0; const row = (ok, what, fix) => { console.log(`  ${ok ? 'ok  ' : 'FIX '} ${what}${ok || !fix ? '' : ` -> ${fix}`}`); if (!ok) bad++; };
    row(Number(process.versions.node.split('.')[0]) >= 24, `Node ${process.versions.node}`, 'install Node 24 or newer');
    row(!!c, 'config and tokens', 'clockwork init');
    row(fs.existsSync(path.join(ROOT, 'core', 'node_modules')), 'core dependencies', './install.sh');
    const py = c ? python(c) : paths.venvPython(); const hasPy = fs.existsSync(py); row(hasPy, 'Python environment for the local model', './install.sh');
    if (hasPy) row(spawnSync(py, ['-c', 'import sentence_transformers, sklearn, joblib'], { stdio: 'ignore' }).status === 0, 'model libraries', './install.sh');
    for (const x of listExtractors(c || undefined)) {
      if (x.problems.length) { row(false, `extractor ${x.name}: ${x.problems[0]}`); continue; }
      if (!x.enabled) continue; const r = resolveExtractor(x, c); const exe = path.isAbsolute(r.run.command) || r.run.command.startsWith('.') ? fs.existsSync(path.resolve(r.cwd, r.run.command)) : spawnSync('which', [r.run.command], { stdio: 'ignore' }).status === 0;
      row(exe, `extractor ${x.name}: program present`, x.manifest.build ? `clockwork connect ${x.name} builds it${x.manifest.needs ? ` (needs ${x.manifest.needs})` : ''}` : 'see its README');
      if (r.ready) row(fs.existsSync(r.ready), `extractor ${x.name}: account linked`, `clockwork connect ${x.name}`);
      const keys = secretsFor(x.name, r.secrets); if (r.secrets.length) row(!keys.missing.length, `extractor ${x.name}: key saved`, `clockwork connect ${x.name}`);
      if (backend() === 'keychain') for (const s of keys.inFiles) row(false, `extractor ${x.name}: its ${s.prompt} is still in a plain file`, `clockwork connect ${x.name} moves it into your Keychain`);
    }
    console.log(bad ? `\n${bad} thing(s) to fix.` : '\nEverything needed is in place.'); process.exitCode = bad ? 1 : 0;
  },

  async version() { const h = commitOf(); console.log(`Clockwork ${version()}${h ? ` (${h})` : ''}`); },
  /** Newer Clockwork from where this copy was cloned. Nothing is fetched or changed unless this is run. */
  async upgrade() {
    const st = upgradeState(), here = `git -C ${ROOT}`;
    if (st.state === 'not-git') die(`This copy of Clockwork is not a git checkout, so there is nothing to fetch from. Clone it again and run ./install.sh; your data in ${dataDir()} is kept.`);
    if (st.state === 'no-upstream') die(`This checkout does not follow a published branch. Switch to one first, for example: ${here} switch main`);
    if (st.state === 'offline') die(`Could not reach the place this was cloned from (${st.error}).`);
    if (st.state === 'current') return console.log(`Clockwork ${version()} is the newest version.${st.ahead ? ` (This copy has ${st.ahead} change(s) of its own on top.)` : ''}`);
    if (st.state === 'diverged') die(`This copy and the published one have gone separate ways (${st.ahead} change(s) only here, ${st.behind} only there): either you committed changes here, or the published history was rewritten.\nTo take the published version and drop the changes that exist only here:\n  ${here} reset --hard ${st.upstream}\n  ${path.join(ROOT, 'install.sh')}\nYour data in ${dataDir()} is not touched by that.`);
    if (st.state === 'dirty') die(`There are ${st.behind} newer change(s), but files in this copy were edited: ${st.files.slice(0, 5).join(', ')}.\nUndo or commit those edits, then run this again.`);
    console.log(`${st.behind} newer change(s) since ${version()}:`); for (const l of st.log) console.log('  ' + l); if (st.behind > st.log.length) console.log('  ...');
    console.log('What changed for you is described in CHANGELOG.md after the upgrade.');
    if (process.argv.includes('--check')) return;
    if (!await ask('Upgrade now?')) die('Left as it was.');
    const m = applyUpgrade(); if (!m.ok) die(`Could not move to the new version: ${m.err.split('\n').pop()}`);
    if (st.reinstall && spawnSync('sh', [path.join(ROOT, 'install.sh')], { stdio: 'inherit', env: { ...process.env, CLOCKWORK_DATA: dataDir() } }).status !== 0) die('The new version is in place but its install step failed. Fix what it reports and run ./install.sh');
    const now = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'package.json'), 'utf8')).version;
    if (!supervisorAlive()) return console.log(`Now at ${now}. Start it with: clockwork start`);
    if (process.platform === 'darwin' && fs.existsSync(plistPath()) && launchctl('kickstart', '-k', `${domain()}/${LABEL}`).status === 0) return console.log(`Now at ${now}, and restarted. See: clockwork status`);
    console.log(`Now at ${now}. It is still running the old version: stop it and start it again.`);
  },
  async demo() { const { demo } = await import('./demo.mjs'); await demo(); },

  async extractors() {
    const c = need(), st = supervisorAlive() ? readState() : null;
    table([['name', 'source', 'from', 'on', 'state'], ...listExtractors(c).map(x => [x.name, x.manifest?.source ?? '', x.builtin ? 'built in' : (i => i?.from ? `added, unreviewed${i.commit ? ' @' + i.commit.slice(0, 7) : ''}` : 'written here')(addedInfo(x)), x.enabled ? 'yes' : 'no',
      x.problems.length ? 'broken: ' + x.problems[0] : st?.processes?.[x.name]?.state ?? (x.enabled ? 'not running' : '')])]);
    console.log('\nAdded extractors are other people\'s code running as you, with access to whatever accounts they ask you to link. They can only write items into Clockwork.');
  },
  async enable(name) { const c = need(), x = findExtractor(name, c) || die(`No extractor named "${name}". See: clockwork extractors`); if (x.problems.length) die(`"${name}" cannot run: ${x.problems.join('; ')}`);
    c.extractors[name] = { ...(c.extractors[name] || {}), enabled: true }; saveConfig(c); console.log(`${name} is on.`); restartHint(); },
  async disable(name) { const c = need(); if (!c.extractors[name]?.enabled) return console.log(`${name} was not on.`); c.extractors[name].enabled = false; saveConfig(c); console.log(`${name} is off.`); restartHint(); },
  async connect(name) {
    const c = need(), x = findExtractor(name, c) || die(`No extractor named "${name}". See: clockwork extractors`); if (x.problems.length) die(`"${name}" cannot run: ${x.problems.join('; ')}`);
    const r = resolveExtractor(x, c), m = x.manifest; fs.mkdirSync(paths.extractorData(name), { recursive: true, mode: 0o700 });
    for (const f of m.requires || []) { const p = String(f.file).replace('{data}', dataDir()).replace('{extractorData}', paths.extractorData(name)); if (!fs.existsSync(p)) die(`${name} needs a file first:\n  ${p}\n${f.help || ''}`); }
    for (const f of tighten(paths.extractorData(name))) console.log(`${f} could be read by other users of this machine. Now only you can.`);
    await collectSecrets(name, r.secrets); r.env = { ...r.env, ...secretsFor(name, r.secrets).env };   // only for the linking step below; a trial run (clockwork check) never gets them
    for (const step of ['install', 'build']) if (r[step] && !(m.builtOutput && fs.existsSync(path.resolve(r.cwd, m.builtOutput)))) { console.log(`${step}: ${r[step].command} ${r[step].args.join(' ')}`); if (!runHere(r[step], r.env, r.cwd)) die(`${step} failed${m.needs ? ` (this extractor needs ${m.needs})` : ''}.`); }
    const was = c.extractors[name]?.enabled; c.extractors[name] = { ...(c.extractors[name] || {}), enabled: true }; saveConfig(c);
    if (m.connect?.note) console.log(m.connect.note);
    const k = r.connect;
    if (k?.type === 'command') { if (!runHere(k, r.env, r.cwd)) die('Linking did not finish.'); }
    else if (k?.type === 'flag') { writePrivate(k.file, new Date().toISOString()); }
    if (supervisorAlive()) console.log(`${name} is on${was ? '' : ' and will start within a few seconds'}.`);
    else console.log(`${name} is on. Start Clockwork with: clockwork start`);
    if (k?.type === 'open') { console.log(`Then open ${k.url}`); if (supervisorAlive() && process.platform === 'darwin' && process.stdout.isTTY && !process.env.CLOCKWORK_NO_OPEN) spawn('open', [k.url], { stdio: 'ignore', detached: true }).unref(); }
  },
  async add(src) {
    const c = need(); if (!src) die('Give a folder or a git address. For example: clockwork add ./my-extractor');
    const got = obtain(src);
    try {
      const m = reviewed(got, src);
      if (listExtractors(c).some(x => x.name === m.name)) die(`There is already an extractor named "${m.name}". To replace an added one: clockwork update ${m.name}`);
      describe(m, src, got.commit);
      if (!await ask(`Add "${m.name}"?`)) die('Not added.');
      place(got, m, src);
      console.log(`Added${got.commit ? ` at version ${got.commit.slice(0, 12)}` : ''}. It stays at this version until you run clockwork update ${m.name}.\nCheck it with: clockwork check ${m.name}\nLink its account and switch it on with: clockwork connect ${m.name}`);
    } finally { if (got.tmp) fs.rmSync(got.tmp, { recursive: true, force: true }); }
  },
  async update(name, ref) {
    const c = need(), x = findExtractor(name, c) || die(`No extractor named "${name}".`); if (x.builtin) die(`"${name}" is built in: it is updated with Clockwork itself.`);
    let info = {}; try { info = JSON.parse(fs.readFileSync(path.join(x.dir, '.added.json'), 'utf8')); } catch {}
    if (!info.from) die(`"${name}" was written here, not added from somewhere, so there is nothing to fetch.`);
    const src = isGit(info.from) ? info.from.split('#')[0] + (ref ? '#' + ref : '') : info.from, got = obtain(src);
    try {
      const m = reviewed(got, src); if (m.name !== name) die(`That address now holds an extractor named "${m.name}", not "${name}".`);
      if (got.commit && got.commit === info.commit) return console.log(`${name} is already at version ${got.commit.slice(0, 12)}.`);
      describe(m, src, got.commit, info.commit);
      if (!await ask(`Replace "${name}" with this version?`)) die('Kept the version you had.');
      fs.rmSync(x.dir, { recursive: true, force: true }); place(got, m, src);
      console.log(`Updated.${c.extractors[name]?.enabled && supervisorAlive() ? ` It is still running the old version: clockwork disable ${name}, wait ten seconds, then clockwork connect ${name}.` : ''}`);
    } finally { if (got.tmp) fs.rmSync(got.tmp, { recursive: true, force: true }); }
  },
  /** Validate an extractor, run it once against a stand-in for the core, then run it offline over its sample input. Nothing reaches the real database. */
  async check(target) {
    const c = need(); if (!target) die('Which extractor? Give a name or a folder. For example: clockwork check my-feed');
    let x = findExtractor(target, c);
    if (!x) { const dir = path.resolve(target); let m = null; try { m = JSON.parse(fs.readFileSync(path.join(dir, 'extractor.json'), 'utf8')); } catch { die(`No extractor named "${target}" and no readable extractor.json in ${dir}`); }
      const problems = manifestProblems(m); if (m.cwd !== undefined) problems.push('"cwd" is only for built-in extractors'); x = { name: m.name || 'unnamed', dir, builtin: false, manifest: m, problems }; }
    const bad = [], say = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FIX '} ${what}`); if (!ok) bad.push(what); };
    say(!x.problems.length, x.problems.length ? `manifest: ${x.problems.join('; ')}` : 'manifest is valid'); if (x.problems.length) { process.exitCode = 1; return; }
    const r = resolveExtractor(x, c), m = x.manifest, seconds = Math.min(120, Math.max(5, Number(process.argv.find(a => a.startsWith('--seconds='))?.split('=')[1]) || 20));
    const exe = path.isAbsolute(r.run.command) || r.run.command.startsWith('.') ? fs.existsSync(path.resolve(r.cwd, r.run.command)) : spawnSync('which', [r.run.command], { stdio: 'ignore' }).status === 0;
    say(exe, `program "${r.run.command}" ${exe ? 'is present' : `is missing${m.build || m.install ? ' (run its install and build steps first: clockwork connect ' + x.name + ')' : ''}`}`); if (!exe) { process.exitCode = 1; return; }
    console.log(`  running it for up to ${seconds} s against a stand-in for the core (nothing reaches your real items)`);
    const seen = await trial(m, r, { seconds, done: (s, ms) => s.posts && (s.items || ms > 5000) });
    say(!seen.failed, seen.failed ? `could not start: ${seen.failed}` : 'program starts');
    say(seen.posts > 0, seen.posts ? `reported in ${seen.posts} time(s), ${seen.items} item(s)${seen.status.size ? `, status "${[...seen.status].join('", "')}"` : ''}` : `sent nothing to /ingest/events within ${seconds} s (it must report in at start, even with nothing new)`);
    for (const p of seen.bad) say(false, p);
    if (seen.other.size) say(false, `asked the core for something an extractor cannot have: ${[...seen.other].slice(0, 3).join(', ')}`);
    for (const n of seen.notes) console.log(`  note ${n}`);
    const fixtures = path.join(r.cwd, 'fixtures'), files = fixtureFiles(fixtures);
    if (files.length && !seen.failed) await fixtureRuns(m, r, fixtures, files, say);
    else if (!files.length) console.log('  note no sample input in a fixtures/ folder, so its reading code was not tried offline (docs/EXTRACTORS.md, "Fixtures")');
    console.log(bad.length ? `\n${bad.length} thing(s) to fix.` : '\nThis extractor follows the contract. The check cannot tell what else the program does: read the code of anything you did not write.'); process.exitCode = bad.length ? 1 : 0;
  },
  async new(name, kind = 'basic') {
    const c = need(); if (!NAME.test(name || '')) die('Give it a short lower-case name. For example: clockwork new my-feed');
    const from = path.join(ROOT, 'extractors', 'templates', kind);
    if (!Object.hasOwn(KINDS, kind) || !fs.existsSync(from)) die(`There is no "${kind}" template. Choose by how the source is reached:\n${Object.entries(KINDS).map(([k, v]) => `  clockwork new ${name} ${k}`.padEnd(36) + v).join('\n')}`);
    if (listExtractors(c).some(x => x.name === name)) die(`There is already an extractor named "${name}".`);
    const dest = path.join(paths.userExtractors(), name); fs.mkdirSync(paths.userExtractors(), { recursive: true, mode: 0o700 }); fs.cpSync(from, dest, { recursive: true });
    const f = path.join(dest, 'extractor.json'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('my-source', name));
    console.log(`Created ${dest} from the "${kind}" template (${KINDS[kind]}).\nEdit main.mjs where it says "Replace" (the contract is in docs/EXTRACTORS.md), and put made-up sample input in fixtures/.\nTry it offline, whole and with damaged input: clockwork check ${name}\nThen switch it on: clockwork ${kind === 'basic' ? 'enable' : 'connect'} ${name}`);
  },
  async remove(name) {
    const c = need(), x = findExtractor(name, c) || die(`No extractor named "${name}".`); if (x.builtin) die(`"${name}" is built in. Switch it off instead: clockwork disable ${name}`);
    if (!await ask(`Delete the extractor "${name}" from ${x.dir}? Items it already brought in stay.`)) die('Kept.');
    for (const s of x.manifest?.secrets || []) try { deleteSecret(name, s.name); } catch {}
    fs.rmSync(x.dir, { recursive: true, force: true }); delete c.extractors[name]; saveConfig(c); console.log('Removed.'); restartHint();
  },

  async agent() {
    const c = need();
    console.log(`Connect your agent to Clockwork over MCP:

  address   ${coreUrl(c)}/mcp
  token     in ${paths.agentToken()} (send it as "Authorization: Bearer <token>")
  skill     ${path.join(ROOT, 'agent', 'SKILL.md')}

Give the skill file to your agent (for OpenClaw: copy the agent/ folder into its skills folder as "clockwork").
The agent token can read your items and label them, and choose which messages wake it as they arrive.
It cannot change other settings or add extractors.
Only connect an agent that asks you before it sends messages or posts on your behalf.
Setup is finished when your agent's get_setup_status tool says so; clockwork status shows the same list.`);
    if (c.publicUrl) console.log(`\nAgents outside this machine (ChatGPT): add ${c.publicUrl}/mcp with OAuth; approve with the admin token in ${paths.config()}.`);
    else console.log('\nFor an agent that runs somewhere else (ChatGPT), see "Reaching Clockwork from outside" in docs/LOCAL.md.');
  },
  async train() {
    const c = need(); if (!fs.existsSync(python(c))) die('The Python environment is missing. Run ./install.sh');
    const { studentEnv } = await import('./lib.mjs'); const up = supervisorAlive();
    const ok = spawnSync(python(c), ['train.py', ...process.argv.slice(3).filter(a => a === '--force')], { cwd: path.join(ROOT, 'student'), stdio: 'inherit', env: { ...studentEnv(c), ...(up ? { CLOCKWORK_EMBED_VIA: `http://127.0.0.1:${c.studentPort}` } : {}) } }).status === 0;
    if (ok && up) await fetch(`http://127.0.0.1:${c.studentPort}/reload`, { method: 'POST', body: '{}' }).catch(() => {});
    process.exitCode = ok ? 0 : 1;
  },
  async help() { console.log(HELP); },
};

const [cmd = 'help', ...rest] = process.argv.slice(2).filter(a => !a.startsWith('--') || a === '--help');
const fn = commands[cmd === '--help' || cmd === '-h' ? 'help' : cmd];
if (!fn) die(`Unknown command "${cmd}".\n\n${HELP}`);
fn(...rest).catch(e => die(e.message));
