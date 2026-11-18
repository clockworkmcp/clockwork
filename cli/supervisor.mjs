// `clockwork run`: keeps one local Clockwork instance alive. The core is required; the scorer, the nightly trainer and each
// enabled extractor are restarted in place. State goes to run/state.json (no message content), output to logs/<name>.log.
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
import { ROOT, paths, loadConfig, listExtractors, resolveExtractor, coreEnv, studentEnv, coreUrl, python, writePrivate, supervisorAlive } from './lib.mjs';

const MAX_LOG = 5 * 1024 * 1024;
export function logStream(name) {
  fs.mkdirSync(paths.logs(), { recursive: true, mode: 0o700 }); const file = path.join(paths.logs(), name + '.log');
  try { if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, file + '.1'); } catch {}
  return fs.openSync(file, 'a', 0o600);
}

export async function supervise({ config = loadConfig(), firstTrainMs = 10 * 60e3, startCore = true, log = m => console.log(`${new Date().toISOString()} ${m}`) } = {}) {
  if (!config) throw new Error('not set up yet: run `clockwork init`');
  if (supervisorAlive()) throw new Error('Clockwork is already running (clockwork status)');
  writePrivate(paths.pid(), String(process.pid));
  const state = { pid: process.pid, startedAt: new Date().toISOString(), processes: {} }, children = new Map(), timers = new Set(); let stopping = false;
  const save = () => writePrivate(paths.state(), JSON.stringify(state, null, 1));
  const set = (name, patch) => { state.processes[name] = { ...(state.processes[name] || {}), ...patch, since: new Date().toISOString() }; save(); };
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); if (!stopping) fn(); }, ms); timers.add(t); };

  /** Start `cmd`; when it exits, start it again after `pause` seconds unless `gate` says it is not ready to run. */
  function keep(name, { command, args = [], cwd, env, pause = 30, gate, kind }) {
    if (stopping) return;
    const blocked = gate?.();
    if (blocked === 'off') return;
    if (blocked) { if (state.processes[name]?.state !== blocked) { set(name, { kind, state: blocked, pid: undefined }); log(`[${name}] ${blocked}`); } return later(30e3, () => keep(name, arguments[1])); }
    const fd = logStream(name); let child;
    try { child = spawn(command, args, { cwd, env, stdio: ['ignore', fd, fd] }); } finally { fs.closeSync(fd); }
    children.set(name, child); set(name, { kind, state: 'running', pid: child.pid, restarts: (state.processes[name]?.restarts ?? -1) + 1 });
    const again = why => { if (children.get(name) !== child) return; children.delete(name); if (stopping) return; set(name, { kind, state: 'restarting', pid: undefined, last: why }); log(`[${name}] ${why}; again in ${pause}s`); later(pause * 1000, () => keep(name, arguments[1])); };
    child.on('error', e => again(`could not start: ${e.message}`)); child.on('exit', (code, sig) => again(`exited with ${sig || code}`));
    return child;
  }

  // The core: if it cannot stay up there is nothing to supervise, so the whole service exits and launchd starts it afresh.
  const core = startCore && keep('core', { kind: 'core', command: process.execPath, args: ['server.mjs'], cwd: path.join(ROOT, 'core'), env: coreEnv(config), pause: 5 });
  keep('scorer', { kind: 'model', command: python(config), args: ['serve.py'], cwd: path.join(ROOT, 'student'), env: studentEnv(config), pause: 30,
    gate: () => fs.existsSync(python(config)) ? null : 'python environment missing (run install.sh)' });

  // Nightly retrain on the labels collected so far; the scorer loads the new model only if the trainer promoted it.
  const train = () => {
    if (stopping || !fs.existsSync(python(config))) return later(3600e3, train);
    const fd = logStream('trainer'); set('trainer', { kind: 'model', state: 'training' });
    const c = spawn(python(config), ['train.py'], { cwd: path.join(ROOT, 'student'), env: { ...studentEnv(config), CLOCKWORK_EMBED_VIA: `http://127.0.0.1:${config.studentPort}` }, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd); children.set('trainer', c);
    c.on('error', () => {}); c.on('exit', async code => { children.delete('trainer');
      if (code === 0) await fetch(`http://127.0.0.1:${config.studentPort}/reload`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(120e3) }).catch(() => {});
      set('trainer', { kind: 'model', state: 'idle', last: code === 0 ? 'finished' : `failed (${code})`, lastRun: new Date().toISOString() });
      later((config.retrainHours || 24) * 3600e3, train); });
  };
  later(firstTrainMs, train);

  const stop = why => { if (stopping) return; stopping = true; log(`stopping: ${why}`); for (const t of timers) clearTimeout(t);
    for (const c of children.values()) try { c.kill('SIGTERM'); } catch {}
    setTimeout(() => { for (const c of children.values()) try { c.kill('SIGKILL'); } catch {} }, 8000).unref();
    try { fs.rmSync(paths.pid(), { force: true }); state.stoppedAt = new Date().toISOString(); for (const p of Object.values(state.processes)) { p.state = 'stopped'; delete p.pid; } save(); } catch {} };
  process.once('SIGTERM', () => stop('asked to stop')); process.once('SIGINT', () => stop('interrupted'));

  // Extractors: each enabled one, with only the write-only ingest token in its environment. The list is re-read every few
  // seconds, so `clockwork connect`, `enable`, `disable` and `remove` take effect without a restart.
  const wanted = new Map();
  const reconcile = () => {
    const fresh = loadConfig() || config; const on = new Map(listExtractors(fresh).filter(x => x.enabled).map(x => [x.name, x]));
    for (const [name] of wanted) if (!on.has(name)) { wanted.delete(name); const c = children.get(name); children.delete(name); try { c?.kill('SIGTERM'); } catch {} delete state.processes[name]; save(); log(`[${name}] switched off`); }
    for (const [name, x] of on) {
      if (wanted.has(name)) continue; wanted.set(name, x);
      const r = resolveExtractor(x, fresh); fs.mkdirSync(paths.extractorData(name), { recursive: true, mode: 0o700 });
      keep(name, { kind: x.builtin ? 'extractor' : 'extractor (added)', command: r.run.command, args: r.run.args, cwd: r.cwd, env: r.env, pause: Number(x.manifest.restartSeconds) || 60,
        gate: () => wanted.get(name) !== x ? 'off' : r.ready && !fs.existsSync(r.ready) ? `needs connecting (clockwork connect ${name})` : null });
    }
  };
  // Wait for the core to answer before starting extractors, so their first delivery is not lost to a start-up race.
  for (let i = 0; i < 60 && !stopping; i++) { if (await fetch(coreUrl(config) + '/health', { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 1000)); }
  if (!stopping) reconcile(); const rescan = setInterval(() => { if (!stopping) try { reconcile(); } catch (e) { log(`could not re-read extractors: ${e.message}`); } }, 10e3); rescan.unref();

  let coreFails = 0; const watch = setInterval(async () => {
    if (stopping) return clearInterval(watch);
    const ok = await fetch(coreUrl(config) + '/health', { signal: AbortSignal.timeout(5000) }).then(r => r.ok, () => false);
    coreFails = ok ? 0 : coreFails + 1; if (coreFails >= 12) { stop('the core has not answered for a minute'); process.exitCode = 1; }
  }, 5000); watch.unref();
  log(`clockwork running: ${coreUrl(config)} (data in ${path.dirname(paths.config())})`);
  return { stop, state, core };
}
