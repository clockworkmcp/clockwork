#!/usr/bin/env node
// The `clockwork` command: set up, run and inspect one local Clockwork instance, and manage its extractors.
import { spawn, spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import readline from 'node:readline/promises';
import { ROOT, LABEL, NAME, paths, dataDir, loadConfig, saveConfig, initConfig, coreUrl, listExtractors, findExtractor, resolveExtractor, manifestProblems,
  plist, plistPath, readState, supervisorAlive, python, writePrivate } from './lib.mjs';

const HELP = `clockwork: personal feed triage that runs on your own machine

  clockwork init                 create the config and access tokens (safe to repeat)
  clockwork start | stop         run in the background and at login | stop
  clockwork run                  run in this terminal instead
  clockwork status               what is running, what each source last saw, how training is going
  clockwork logs <name>          recent output of one part (core, scorer, trainer or an extractor)
  clockwork doctor               check that everything needed is installed

  clockwork extractors           list extractors and whether each is on
  clockwork connect <name>       switch an extractor on and link its account (whatsapp, gmail, x, ...)
  clockwork enable|disable <name>
  clockwork add <folder|git-url> add an extractor someone else wrote (shows what it will run and asks first)
  clockwork update <name> [ref]  fetch a newer version of an added extractor (asks first; never happens by itself)
  clockwork new <name>           start your own extractor from the template
  clockwork check <name|folder>  validate an extractor and give it one trial run that touches none of your items
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
    }
    console.log(bad ? `\n${bad} thing(s) to fix.` : '\nEverything needed is in place.'); process.exitCode = bad ? 1 : 0;
  },

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
  /** Validate an extractor and run it once against a stand-in for the core, so nothing reaches the real database. */
  async check(target) {
    const c = need(); if (!target) die('Which extractor? Give a name or a folder. For example: clockwork check my-feed');
    let x = findExtractor(target, c);
    if (!x) { const dir = path.resolve(target); let m = null; try { m = JSON.parse(fs.readFileSync(path.join(dir, 'extractor.json'), 'utf8')); } catch { die(`No extractor named "${target}" and no readable extractor.json in ${dir}`); }
      const problems = manifestProblems(m); if (m.cwd !== undefined) problems.push('"cwd" is only for built-in extractors'); x = { name: m.name || 'unnamed', dir, builtin: false, manifest: m, problems }; }
    const bad = [], note = [], say = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FIX '} ${what}`); if (!ok) bad.push(what); };
    say(!x.problems.length, x.problems.length ? `manifest: ${x.problems.join('; ')}` : 'manifest is valid'); if (x.problems.length) { process.exitCode = 1; return; }
    const r = resolveExtractor(x, c), m = x.manifest, seconds = Math.min(120, Math.max(5, Number(process.argv.find(a => a.startsWith('--seconds='))?.split('=')[1]) || 20));
    const exe = path.isAbsolute(r.run.command) || r.run.command.startsWith('.') ? fs.existsSync(path.resolve(r.cwd, r.run.command)) : spawnSync('which', [r.run.command], { stdio: 'ignore' }).status === 0;
    say(exe, `program "${r.run.command}" ${exe ? 'is present' : `is missing${m.build || m.install ? ' (run its install and build steps first: clockwork connect ' + x.name + ')' : ''}`}`); if (!exe) { process.exitCode = 1; return; }
    const http = await import('node:http'), crypto = await import('node:crypto'), token = crypto.randomBytes(16).toString('hex'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-check-'));
    const seen = { posts: 0, items: 0, other: new Set(), status: new Set() }, itemBad = new Set();
    const server = http.createServer((req, res) => { let body = ''; req.on('data', d => { body += d; if (body.length > 9e6) req.destroy(); }); req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/ingest/events') { seen.other.add(`${req.method} ${req.url}`); res.writeHead(403); return res.end('{}'); }
      if (req.headers.authorization !== 'Bearer ' + token) itemBad.add('a request came without the token from CLOCKWORK_INGEST_TOKEN');
      let j = null; try { j = JSON.parse(body); } catch { itemBad.add('a request body was not JSON'); }
      if (j) { seen.posts++; if (j.source !== m.source) itemBad.add(`"source" was ${JSON.stringify(j.source)}; the manifest says "${m.source}"`);
        if (!Array.isArray(j.events)) itemBad.add('"events" was not a list'); else for (const e of j.events) { seen.items++;
          if (typeof e?.sourceId !== 'string' || !e.sourceId) itemBad.add('an item has no "sourceId"');
          if (e?.direction !== undefined && !['incoming', 'outgoing'].includes(e.direction)) itemBad.add(`"direction" was ${JSON.stringify(e.direction)}`);
          if (e?.sourceTime !== undefined && Number.isNaN(Date.parse(e.sourceTime))) itemBad.add(`"sourceTime" ${JSON.stringify(e.sourceTime)} is not a date`);
          if (e?.text !== undefined && typeof e.text !== 'string') itemBad.add('"text" was not a string');
          if (e?.sourceTime === undefined) note.push('items have no "sourceTime": queues are ordered by it'); }
        if (typeof j.status === 'string') seen.status.add(j.status); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: j?.events?.length || 0, new: j?.events?.length || 0 })); }); });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    console.log(`  running it for up to ${seconds} s against a stand-in for the core (nothing reaches your real items)`);
    const child = spawn(r.run.command, r.run.args, { cwd: r.cwd, detached: true, stdio: 'ignore', env: { ...r.env, CLOCKWORK_CORE_URL: `http://127.0.0.1:${server.address().port}`, CLOCKWORK_INGEST_TOKEN: token, CLOCKWORK_EXTRACTOR_DATA: tmp } });
    let failed = null; child.on('error', e => { failed = e.message; });
    const end = Date.now() + seconds * 1000; while (Date.now() < end && !failed && !(seen.posts && (seen.items || Date.now() > end - (seconds - 5) * 1000))) await new Promise(ok => setTimeout(ok, 200));
    try { process.kill(-child.pid, 'SIGTERM'); } catch {} server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true });
    say(!failed, failed ? `could not start: ${failed}` : 'program starts');
    say(seen.posts > 0, seen.posts ? `reported in ${seen.posts} time(s), ${seen.items} item(s)${seen.status.size ? `, status "${[...seen.status].join('", "')}"` : ''}` : `sent nothing to /ingest/events within ${seconds} s (it must report in at start, even with nothing new)`);
    for (const p of itemBad) say(false, p);
    if (seen.other.size) say(false, `asked the core for something an extractor cannot have: ${[...seen.other].slice(0, 3).join(', ')}`);
    for (const n of new Set(note)) console.log(`  note ${n}`);
    console.log(bad.length ? `\n${bad.length} thing(s) to fix.` : '\nThis extractor follows the contract. The check cannot tell what else the program does: read the code of anything you did not write.'); process.exitCode = bad.length ? 1 : 0;
  },
  async new(name) {
    const c = need(); if (!NAME.test(name || '')) die('Give it a short lower-case name. For example: clockwork new my-feed');
    if (listExtractors(c).some(x => x.name === name)) die(`There is already an extractor named "${name}".`);
    const dest = path.join(paths.userExtractors(), name); fs.mkdirSync(paths.userExtractors(), { recursive: true, mode: 0o700 }); fs.cpSync(path.join(ROOT, 'extractors', 'template'), dest, { recursive: true });
    const f = path.join(dest, 'extractor.json'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('my-source', name));
    console.log(`Created ${dest}\nEdit main.mjs (the contract is in docs/EXTRACTORS.md), try it with: node main.mjs --once\nThen switch it on: clockwork enable ${name}`);
  },
  async remove(name) {
    const c = need(), x = findExtractor(name, c) || die(`No extractor named "${name}".`); if (x.builtin) die(`"${name}" is built in. Switch it off instead: clockwork disable ${name}`);
    if (!await ask(`Delete the extractor "${name}" from ${x.dir}? Items it already brought in stay.`)) die('Kept.');
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
Only connect an agent that asks you before it sends messages or posts on your behalf.`);
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

const [cmd = 'help', ...rest] = process.argv.slice(2).filter(a => a !== '--yes' && !a.startsWith('--seconds='));
const fn = commands[cmd === '--help' || cmd === '-h' ? 'help' : cmd];
if (!fn) die(`Unknown command "${cmd}".\n\n${HELP}`);
fn(...rest).catch(e => die(e.message));
