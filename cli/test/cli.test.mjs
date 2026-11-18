// Tests for the local install: manifests, least-privilege environments, the login service file, and one real run of the
// supervisor with a stub core and a template extractor. Everything happens in a temporary data folder.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { spawnSync, spawn } from 'node:child_process';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-cli-')); process.env.CLOCKWORK_DATA = DATA;
const lib = await import('../lib.mjs');
const CLI = path.join(lib.ROOT, 'cli', 'clockwork.mjs');
const cw = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, CLOCKWORK_DATA: DATA, CLOCKWORK_NO_OPEN: '1' }, input: '' });
test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('init creates private config and tokens once, and never prints a token', () => {
  const a = cw('init'); assert.equal(a.status, 0); const c = lib.loadConfig();
  for (const k of ['admin', 'agent', 'ingest']) { assert.match(c.tokens[k], /^[0-9a-f]{64}$/); assert.ok(!a.stdout.includes(c.tokens[k])); }
  assert.equal(new Set(Object.values(c.tokens)).size, 3);
  assert.equal(fs.statSync(lib.paths.config()).mode & 0o777, 0o600); assert.equal(fs.statSync(lib.paths.agentToken()).mode & 0o777, 0o600);
  cw('init'); assert.deepEqual(lib.loadConfig().tokens, c.tokens, 'a second init keeps the tokens');
  assert.equal(c.teacherMode, 'agent'); assert.equal(c.graduateAgreement, 0.95);
  assert.ok(!cw('agent').stdout.includes(c.tokens.agent), '`clockwork agent` points at the token file instead of printing it');
});

test('built-in extractors are valid, off by default, and the template is not listed', () => {
  const xs = lib.listExtractors(lib.loadConfig());
  assert.deepEqual(xs.filter(x => x.builtin).map(x => x.name).sort(), ['bluesky', 'calendar', 'discord', 'github', 'gitlab', 'gmail', 'hackernews', 'imessage', 'jira', 'linear', 'mastodon', 'outlook', 'rss', 'slack', 'whatsapp', 'x']);
  for (const x of xs) { assert.deepEqual(x.problems, [], x.name); assert.equal(x.enabled, false); }
});

test('manifest rules: names, commands, no token overrides, local connect pages only', () => {
  const ok = { name: 'feed', source: 'feed', run: { command: 'node', args: ['main.mjs'] } };
  assert.deepEqual(lib.manifestProblems(ok), []);
  assert.ok(lib.manifestProblems({ ...ok, name: 'Bad Name' }).length);
  assert.ok(lib.manifestProblems({ ...ok, run: { command: 'node', args: [1] } }).length);
  assert.ok(lib.manifestProblems({ ...ok, run: 'node main.mjs' }).length);
  for (const k of ['CLOCKWORK_TOKEN', 'CLOCKWORK_AGENT_TOKEN', 'CLOCKWORK_INGEST_TOKEN', 'CLOCKWORK_CORE_URL', 'CLOCKWORK_DATA', 'ANTHROPIC_API_KEY'])
    assert.ok(lib.manifestProblems({ ...ok, env: { [k]: 'x' } }).length, k);
  assert.ok(lib.manifestProblems({ ...ok, connect: { type: 'open', url: 'https://evil.example/login' } }).length, 'a connect page must be on this machine');
  assert.deepEqual(lib.manifestProblems({ ...ok, connect: { type: 'open', url: 'http://127.0.0.1:4599' } }), []);
  assert.ok(lib.manifestProblems({ ...ok, restartSeconds: 1 }).length);
});

test('an extractor gets the write-only token and nothing else of value', () => {
  const c = lib.loadConfig(); process.env.ANTHROPIC_API_KEY = 'sk-test-not-real'; process.env.OPENAI_API_KEY = 'sk-test-not-real';
  try {
    const env = lib.extractorEnv(c, 'feed', { MY_SETTING: '1' });
    assert.equal(env.CLOCKWORK_INGEST_TOKEN, c.tokens.ingest); assert.equal(env.CLOCKWORK_CORE_URL, 'http://127.0.0.1:4600');
    const text = JSON.stringify(env);
    for (const secret of [c.tokens.admin, c.tokens.agent, 'sk-test-not-real']) assert.ok(!text.includes(secret));
    assert.deepEqual(Object.keys(env).filter(k => k.startsWith('CLOCKWORK_')).sort(), ['CLOCKWORK_CORE_URL', 'CLOCKWORK_EXTRACTOR_DATA', 'CLOCKWORK_INGEST_TOKEN']);
    const core = lib.coreEnv(c); assert.equal(core.CLOCKWORK_HOST, '127.0.0.1', 'the core listens on this machine only'); assert.equal(core.ANTHROPIC_API_KEY, undefined, 'no model key unless the built-in teacher is chosen');
    assert.equal(lib.coreEnv({ ...c, teacherMode: 'builtin' }).ANTHROPIC_API_KEY, 'sk-test-not-real');
    assert.ok(!JSON.stringify(lib.studentEnv(c)).includes(c.tokens.admin));
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; }
});

test('add: refuses without consent, refuses bad or clashing manifests, copies on --yes; new, enable, disable, remove', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-src-')); const write = m => fs.writeFileSync(path.join(src, 'extractor.json'), JSON.stringify(m));
  const good = { name: 'feed', source: 'feed', run: { command: 'node', args: ['main.mjs'] } };
  fs.writeFileSync(path.join(src, 'main.mjs'), ''); fs.mkdirSync(path.join(src, 'node_modules')); fs.writeFileSync(path.join(src, 'node_modules', 'junk'), 'x');
  write(good); let r = cw('add', src); assert.notEqual(r.status, 0); assert.match(r.stdout, /code from outside that will run as you/); assert.ok(!fs.existsSync(path.join(DATA, 'extractors', 'feed')), 'nothing copied without a yes');
  write({ ...good, env: { CLOCKWORK_TOKEN: 'x' } }); assert.notEqual(cw('add', src, '--yes').status, 0);
  write({ ...good, cwd: '/' }); assert.notEqual(cw('add', src, '--yes').status, 0);
  write({ ...good, name: 'whatsapp' }); assert.notEqual(cw('add', src, '--yes').status, 0, 'cannot shadow a built-in');
  write(good); r = cw('add', src, '--yes'); assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(DATA, 'extractors', 'feed', 'main.mjs'))); assert.ok(!fs.existsSync(path.join(DATA, 'extractors', 'feed', 'node_modules')));
  assert.equal(lib.findExtractor('feed', lib.loadConfig()).enabled, false, 'added but not switched on until the user says so');
  assert.equal(cw('enable', 'feed').status, 0); assert.equal(lib.findExtractor('feed', lib.loadConfig()).enabled, true);
  assert.equal(cw('disable', 'feed').status, 0); assert.equal(lib.findExtractor('feed', lib.loadConfig()).enabled, false);
  assert.equal(cw('new', 'mine').status, 0); assert.equal(lib.findExtractor('mine', lib.loadConfig()).manifest.source, 'mine');
  assert.notEqual(cw('remove', 'whatsapp', '--yes').status, 0, 'built-ins cannot be deleted');
  assert.equal(cw('remove', 'feed', '--yes').status, 0); assert.equal(lib.findExtractor('feed', lib.loadConfig()), undefined);
  fs.rmSync(src, { recursive: true, force: true });
});

test('check: the template passes a trial run that touches no real items; a wrong source or a silent program fails', () => {
  assert.equal(cw('new', 'trial').status, 0);
  const ok = cw('check', 'trial', '--seconds=10'); assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /1 item/); assert.match(ok.stdout, /follows the contract/);
  assert.ok(!fs.existsSync(path.join(lib.paths.extractorData('trial'), 'state.json')), 'the trial run uses a throwaway state folder');
  const dir = path.join(lib.paths.userExtractors(), 'trial'), main = path.join(dir, 'main.mjs');
  fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace('source: SOURCE,', "source: 'something-else',"));
  const wrong = cw('check', 'trial', '--seconds=10'); assert.equal(wrong.status, 1); assert.match(wrong.stdout, /the manifest says "trial"/);
  fs.writeFileSync(main, 'setTimeout(() => {}, 60000);\n');
  const silent = cw('check', 'trial', '--seconds=5'); assert.equal(silent.status, 1); assert.match(silent.stdout, /sent nothing/);
  assert.equal(cw('remove', 'trial', '--yes').status, 0);
});

test('add from a git address pins the exact version; update asks, and only moves when the user says so', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-repo-')), git = (...a) => { const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  try {
    fs.cpSync(path.join(lib.ROOT, 'extractors', 'template'), repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'extractor.json'), fs.readFileSync(path.join(repo, 'extractor.json'), 'utf8').replaceAll('my-source', 'pinned'));
    git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'one'); const first = git('rev-parse', 'HEAD'), url = 'file://' + repo;
    assert.notEqual(cw('add', url).status, 0, 'no consent, no install'); assert.ok(!fs.existsSync(path.join(lib.paths.userExtractors(), 'pinned')));
    const a = cw('add', url, '--yes'); assert.equal(a.status, 0, a.stderr); assert.match(a.stdout, /Nobody at Clockwork has reviewed this/); assert.ok(a.stdout.includes(first));
    const info = () => JSON.parse(fs.readFileSync(path.join(lib.paths.userExtractors(), 'pinned', '.added.json'), 'utf8'));
    assert.equal(info().commit, first); assert.match(cw('extractors').stdout, new RegExp('unreviewed @' + first.slice(0, 7)));
    assert.match(cw('update', 'pinned', '--yes').stdout, /already at version/);
    fs.appendFileSync(path.join(repo, 'main.mjs'), '// changed\n'); git('commit', '-q', '-am', 'two'); const second = git('rev-parse', 'HEAD');
    assert.notEqual(cw('update', 'pinned').status, 0); assert.equal(info().commit, first, 'declined: stays at the pinned version');
    const u = cw('update', 'pinned', '--yes'); assert.equal(u.status, 0, u.stderr); assert.equal(info().commit, second);
    assert.match(fs.readFileSync(path.join(lib.paths.userExtractors(), 'pinned', 'main.mjs'), 'utf8'), /changed/);
    assert.notEqual(cw('update', 'gmail', '--yes').status, 0, 'built-ins are not updated this way');
    assert.equal(cw('remove', 'pinned', '--yes').status, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('connect refuses until required files exist, and does not switch the extractor on', () => {
  const r = cw('connect', 'gmail'); assert.notEqual(r.status, 0); assert.match(r.stderr, /client\.json/); assert.equal(lib.findExtractor('gmail', lib.loadConfig()).enabled, false);
});

test('the login service file is valid and runs `clockwork run` with this data folder', { skip: process.platform !== 'darwin' }, () => {
  const f = path.join(DATA, 'test.plist'); fs.writeFileSync(f, lib.plist()); assert.equal(spawnSync('plutil', ['-lint', f]).status, 0);
  const t = fs.readFileSync(f, 'utf8'); assert.match(t, /<string>run<\/string>/); assert.ok(t.includes(DATA)); assert.ok(!t.includes(lib.loadConfig().tokens.admin));
});

test('supervisor: runs an enabled extractor against the core, picks up enable/disable live, and stops its children', async () => {
  // A stand-in core that records what extractors send, so this test needs no model and no database.
  const got = []; const core = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d).on('end', () => {
    if (req.url === '/health') return res.end('{"ok":true}');
    got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') }); res.end('{"received":1,"new":1}'); }); });
  await new Promise(r => core.listen(0, '127.0.0.1', r));
  const c = lib.loadConfig(); c.port = core.address().port; c.studentPort = 1; c.python = '/nonexistent/python'; c.extractors.mine = { enabled: true }; lib.saveConfig(c);
  // Run the supervisor without its own core: point it at the stub by starting only the extractor half through the real entry point.
  const child = spawn(process.execPath, ['-e', `
    import('${path.join(lib.ROOT, 'cli', 'supervisor.mjs')}').then(async m => { await m.supervise({ startCore: false }); });`], { env: { ...process.env, CLOCKWORK_DATA: DATA }, stdio: 'ignore' });
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
  try {
    assert.ok(await until(() => got.some(g => g.body.source === 'mine' && g.body.events?.length === 1)), 'the template extractor delivered its item');
    const first = got.find(g => g.body.source === 'mine'); assert.equal(first.url, '/ingest/events'); assert.equal(first.auth, 'Bearer ' + c.tokens.ingest);
    const st = lib.readState(); assert.equal(st.processes.mine.state, 'running'); assert.match(st.processes.scorer.state, /python environment missing/);
    assert.ok(!JSON.stringify(st).includes(c.tokens.ingest), 'state file holds no tokens');
    const pid = st.processes.mine.pid; cw('disable', 'mine');
    assert.ok(await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 25000), 'a disabled extractor is stopped without a restart');
    assert.equal(lib.readState().processes.mine, undefined);
  } finally { child.kill('SIGTERM'); await new Promise(r => child.on('exit', r)); core.close(); }
  assert.equal(lib.supervisorAlive(), 0);
});
