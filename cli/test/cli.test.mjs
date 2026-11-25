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

test('built-in extractors are valid, off by default, and the templates are not listed', () => {
  const xs = lib.listExtractors(lib.loadConfig());
  assert.deepEqual(xs.filter(x => x.builtin).map(x => x.name).sort(), ['bluesky', 'calendar', 'discord', 'github', 'github-repo', 'gitlab', 'gmail', 'gmail-imap', 'hackernews', 'imessage', 'jira', 'linear', 'mastodon', 'outlook', 'rss', 'slack', 'whatsapp', 'x']);
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

test('new offers a template for each way of reaching a source, and each one passes its check as copied', () => {
  const none = cw('new', 'nope', 'carrier-pigeon'); assert.notEqual(none.status, 0); for (const k of ['basic', 'api', 'mac-app']) assert.match(none.stderr, new RegExp(`clockwork new nope ${k} `));
  assert.ok(!fs.existsSync(path.join(lib.paths.userExtractors(), 'nope')));
  for (const kind of ['api', 'mac-app']) {
    const name = 'kind-' + kind, made = cw('new', name, kind); assert.equal(made.status, 0, made.stderr); assert.match(made.stdout, new RegExp(`"${kind}" template`));
    const x = lib.findExtractor(name, lib.loadConfig()); assert.deepEqual(x.problems, []); assert.equal(x.manifest.source, name); assert.ok(x.manifest.ready || x.manifest.secrets, 'not started until the user has done their part');
    const r = cw('check', name, '--seconds=6'); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /status "needs_login"/, 'with no key and no store it says so; it does not stop'); assert.match(r.stdout, /fixtures: \d file\(s\) of sample input read offline, 4 item\(s\), all well formed/);
    assert.match(r.stdout, /still reports in, and sends nothing malformed, with each file cut short or unreadable/);
    assert.equal(cw('remove', name, '--yes').status, 0);
  }
});

test('check runs an extractor offline over its fixtures, whole and damaged, and catches one that stops or sends rubbish', () => {
  assert.equal(cw('new', 'offline').status, 0);
  const dir = path.join(lib.paths.userExtractors(), 'offline'), main = path.join(dir, 'main.mjs'), original = fs.readFileSync(main, 'utf8'), fixture = path.join(dir, 'fixtures', 'things.json'), sample = fs.readFileSync(fixture, 'utf8');
  const ok = cw('check', 'offline', '--seconds=6'); assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /fixtures: 1 file\(s\) of sample input read offline, 2 item\(s\)/);
  assert.equal(fs.readFileSync(fixture, 'utf8'), sample, 'the damaged copies are made elsewhere; the extractor\'s own fixtures are untouched');
  // One that gives up on input it cannot read: the supervisor would restart it for ever and the user would never be told why.
  fs.writeFileSync(main, original.replace("await send([], 'error').catch(() => {});", 'process.exit(1);'));
  const quits = cw('check', 'offline', '--seconds=6'); assert.equal(quits.status, 1); assert.match(quits.stdout, /with things\.json cut short it stopped without a word/); assert.match(quits.stdout, /with things\.json unreadable it stopped without a word/);
  // One that passes on whatever it is handed without looking.
  fs.writeFileSync(main, original.replace('sourceId: String(t.id),', 'sourceId: t.id,').replace('if (!t?.id) return null;', '')); fs.writeFileSync(fixture, JSON.stringify([{ id: 7, at: 'yesterday-ish', text: 'made up' }]));
  const sloppy = cw('check', 'offline', '--seconds=6'); assert.equal(sloppy.status, 1); assert.match(sloppy.stdout, /the sample input gave something the core would refuse: .*no "sourceId".*is not a date/);
  // One that ignores CLOCKWORK_FIXTURES would be reading the real source during a check.
  fs.writeFileSync(main, original.replace("process.env.CLOCKWORK_FIXTURES || ''", "''").replace("[{ id: 'hello-1'", '[] || [{')); fs.writeFileSync(fixture, sample);
  const deaf = cw('check', 'offline', '--seconds=6'); assert.equal(deaf.status, 1); assert.match(deaf.stdout, /no item came out of the sample input/);
  fs.rmSync(path.join(dir, 'fixtures'), { recursive: true }); fs.writeFileSync(main, original);
  const bare = cw('check', 'offline', '--seconds=6'); assert.equal(bare.status, 0, 'fixtures are encouraged, not required'); assert.match(bare.stdout, /note no sample input in a fixtures\/ folder/);
  assert.equal(cw('remove', 'offline', '--yes').status, 0);
});

test('add from a git address pins the exact version; update asks, and only moves when the user says so', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-repo-')), git = (...a) => { const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  try {
    fs.cpSync(path.join(lib.ROOT, 'extractors', 'templates', 'basic'), repo, { recursive: true });
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

// A stand-in for Apple's `security` program: the few subcommands Clockwork uses, kept in a JSON file, with every command line it was given written down.
function fakeKeychain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-keychain-')), bin = path.join(dir, 'security'), store = path.join(dir, 'items.json'), log = path.join(dir, 'argv.log');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2), items = (() => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(store)}, 'utf8')); } catch { return {}; } })();
fs.appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n');
const opt = (list, k) => list[list.indexOf(k) + 1], save = () => fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(items));
if (a[0] === '-i') { for (const line of fs.readFileSync(0, 'utf8').split('\\n')) { const w = line.trim().split(/\\s+/); if (w[0] === 'add-generic-password') items[opt(w, '-s') + '|' + opt(w, '-a')] = Buffer.from(opt(w, '-X'), 'hex').toString('latin1'); } save(); }
else if (a[0] === 'find-generic-password') { const v = items[opt(a, '-s') + '|' + opt(a, '-a')]; if (v === undefined) process.exit(44); console.log(v); }
else if (a[0] === 'delete-generic-password') { delete items[opt(a, '-s') + '|' + opt(a, '-a')]; save(); }
else process.exit(2);
`, { mode: 0o755 });
  return { dir, env: { CLOCKWORK_SECRETS: 'keychain', CLOCKWORK_SECURITY_BIN: bin }, items: () => { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return {}; } }, argv: () => { try { return fs.readFileSync(log, 'utf8'); } catch { return ''; } } };
}
/** Every file under the data folder that holds `needle`. */
const filesHolding = needle => fs.readdirSync(DATA, { recursive: true }).map(f => path.join(DATA, f)).filter(f => fs.statSync(f).isFile() && fs.readFileSync(f).includes(needle));

test('manifest rules for secrets: named, prompted, and an old key file may only be the extractor\'s own', () => {
  const ok = { name: 'feed', source: 'feed', run: { command: 'node', args: ['main.mjs'] } }, one = s => lib.manifestProblems({ ...ok, secrets: [s] }).length;
  assert.equal(one({ name: 'token', prompt: 'Feed token', help: 'where to get it', pattern: '^tok_', hidden: true, file: '{extractorData}/token' }), 0);
  assert.ok(one({ name: 'Token', prompt: 'x' })); assert.ok(one({ name: 'token' })); assert.ok(one({ name: 'token', prompt: 'x', pattern: '(' }));
  for (const file of ['/etc/passwd', '{data}/config.json', '{extractorData}/../config.json', '{extractorData}/a/b', '~/.ssh/id_ed25519']) assert.ok(one({ name: 'token', prompt: 'x', file }), `${file} is not the extractor's to take`);
  assert.ok(lib.manifestProblems({ ...ok, secrets: [{ name: 'token', prompt: 'a' }, { name: 'token', prompt: 'b' }] }).length, 'no two secrets with one name');
});

test('connect asks for a key, keeps it in the Keychain and nowhere in the data folder, and hands it only to its own extractor', async () => {
  const secrets = await import('../secrets.mjs'), kc = fakeKeychain(), KEY = 'tok_made-up_4f9a1c', NEWER = 'tok_made-up_77b2e0';
  const cwk = (input, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, CLOCKWORK_DATA: DATA, CLOCKWORK_NO_OPEN: '1', ...kc.env }, input });
  const dir = path.join(lib.paths.userExtractors(), 'keyed'), data = lib.paths.extractorData('keyed'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extractor.json'), JSON.stringify({ name: 'keyed', source: 'keyed', run: { command: 'node', args: ['main.mjs'] }, secrets: [{ name: 'token', prompt: 'Feed token', help: 'Made up for the test.', pattern: '^tok_', file: '{extractorData}/token' }] }));
  fs.writeFileSync(path.join(dir, 'main.mjs'), '');
  const x = () => lib.findExtractor('keyed', lib.loadConfig()), handed = () => { Object.assign(process.env, kc.env); try { return secrets.secretsFor('keyed', lib.resolveExtractor(x(), lib.loadConfig()).secrets); } finally { for (const k of Object.keys(kc.env)) delete process.env[k]; } };
  try {
    assert.deepEqual(x().problems, []);
    let r = cwk('', 'connect', 'keyed'); assert.notEqual(r.status, 0); assert.match(r.stderr, /run this yourself in a terminal/); assert.match(r.stderr, /Do not give it to an agent/); assert.equal(x().enabled, false, 'not switched on without its key');
    r = cwk('ghp_not-this-kind\n', 'connect', 'keyed'); assert.notEqual(r.status, 0); assert.match(r.stderr, /not shaped like a Feed token, so nothing was saved/); assert.ok(!r.stderr.includes('ghp_not')); assert.deepEqual(kc.items(), {});
    r = cwk(KEY + '\n', 'connect', 'keyed'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Saved in your macOS Keychain/); assert.ok(!(r.stdout + r.stderr).includes(KEY), 'the key is never printed');
    assert.deepEqual(Object.values(kc.items()), [KEY]); assert.match(Object.keys(kc.items())[0], /^dev\.clockwork\.keyed\.[0-9a-f]{10}\|token$/, 'an item of its own for this extractor and this data folder');
    assert.ok(!kc.argv().includes(KEY), 'the key never appears on a command line, where other programs could list it'); assert.deepEqual(filesHolding(KEY), [], 'and in no file under the data folder');
    assert.equal(x().enabled, true); assert.deepEqual(handed(), { env: { CLOCKWORK_SECRET_TOKEN: KEY }, missing: [], inFiles: [] });
    // A key marked optional is handed over when saved and never counts as missing, so the extractor starts without it.
    Object.assign(process.env, kc.env); try { assert.deepEqual(secrets.secretsFor('keyed', [{ name: 'token', prompt: 'T' }, { name: 'extra', prompt: 'E', optional: true }, { name: 'needed', prompt: 'N' }]).missing, ['needed']); } finally { for (const k of Object.keys(kc.env)) delete process.env[k]; }
    assert.deepEqual(lib.manifestProblems({ name: 'a', source: 'a', run: { command: 'node' }, secrets: [{ name: 'token', prompt: 'T', optional: true }] }), []);
    assert.equal(lib.manifestProblems({ name: 'a', source: 'a', run: { command: 'node' }, secrets: [{ name: 'token', prompt: 'T', optional: 'yes' }] }).length, 1);
    assert.ok(!JSON.stringify(lib.resolveExtractor(x(), lib.loadConfig())).includes(KEY), 'a trial run (clockwork check) is built without it');
    assert.match(cwk('', 'connect', 'keyed').stdout, /Feed token: already saved/);
    r = cwk(NEWER + '\n', 'connect', 'keyed', '--replace'); assert.equal(r.status, 0, r.stderr); assert.deepEqual(Object.values(kc.items()), [NEWER]);

    // A key saved by hand in a file, as older versions asked: readable by others here, to show it is tightened and then moved.
    cwk(NEWER + '\n', 'connect', 'keyed', '--replace'); fs.writeFileSync(path.join(data, 'token'), KEY + '\n', { mode: 0o644 }); fs.chmodSync(path.join(data, 'token'), 0o644);
    for (const k of Object.keys(kc.items())) spawnSync(kc.env.CLOCKWORK_SECURITY_BIN, ['delete-generic-password', '-s', k.split('|')[0], '-a', 'token']);
    assert.deepEqual(handed().inFiles.map(s => s.name), ['token'], 'still runs from the old file until it is moved');
    r = cwk('', 'connect', 'keyed'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /could be read by other users of this machine\. Now only you can\./); assert.match(r.stdout, /moved out of .*token into your macOS Keychain\. The file is deleted\./);
    assert.ok(!fs.existsSync(path.join(data, 'token'))); assert.deepEqual(Object.values(kc.items()), [KEY]); assert.deepEqual(filesHolding(KEY), []);

    // On a machine whose host keeps secrets (a container), the host's variable wins and nothing is asked or stored.
    const hosted = spawnSync(process.execPath, [CLI, 'connect', 'keyed', '--replace'], { encoding: 'utf8', input: '', env: { ...process.env, CLOCKWORK_DATA: DATA, ...kc.env, CLOCKWORK_SECRET_KEYED_TOKEN: 'tok_from-the-host' } });
    assert.equal(hosted.status, 0, hosted.stderr); assert.match(hosted.stdout, /set by this machine's own secret store \(CLOCKWORK_SECRET_KEYED_TOKEN\)/); assert.deepEqual(Object.values(kc.items()), [KEY]);

    assert.equal(cwk('', 'remove', 'keyed', '--yes').status, 0); assert.deepEqual(kc.items(), {}, 'removing an extractor removes its key');
  } finally { fs.rmSync(kc.dir, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without a keychain the key goes in a file only the user can read; it cannot be a strange value', async () => {
  const secrets = await import('../secrets.mjs'); process.env.CLOCKWORK_SECRETS = 'file';
  try {
    assert.equal(secrets.getSecret('feed', 'token'), null); secrets.setSecret('feed', 'token', 'tok_plain'); assert.equal(secrets.getSecret('feed', 'token'), 'tok_plain');
    const f = path.join(DATA, 'secrets', 'feed.json'); assert.equal(fs.statSync(f).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
    for (const bad of ['', 'two\nlines', 'tab\there', 'café']) assert.throws(() => secrets.setSecret('feed', 'token', bad), /plain letters, digits and symbols on one line/);
    assert.throws(() => secrets.getSecret('../config', 'token'), /not a secret name/);
    process.env.CLOCKWORK_SECRET_FEED_TOKEN = 'tok_host'; assert.equal(secrets.getSecret('feed', 'token'), 'tok_host'); assert.throws(() => secrets.setSecret('feed', 'token', 'tok_other'), /comes from there/); delete process.env.CLOCKWORK_SECRET_FEED_TOKEN;
    secrets.deleteSecret('feed', 'token'); assert.equal(secrets.getSecret('feed', 'token'), null); assert.ok(!fs.existsSync(f));
  } finally { delete process.env.CLOCKWORK_SECRETS; delete process.env.CLOCKWORK_SECRET_FEED_TOKEN; }
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
  // A second extractor that needs a key. It proves it was handed the key by sending its fingerprint, never the key itself.
  const KEY = 'tok_made-up_supervised', kdir = path.join(lib.paths.userExtractors(), 'locked'); fs.mkdirSync(kdir, { recursive: true });
  fs.writeFileSync(path.join(kdir, 'extractor.json'), JSON.stringify({ name: 'locked', source: 'locked', run: { command: 'node', args: ['main.mjs'] }, secrets: [{ name: 'token', prompt: 'Feed token' }] }));
  fs.writeFileSync(path.join(kdir, 'main.mjs'), `import crypto from 'node:crypto'; const k = process.env.CLOCKWORK_SECRET_TOKEN || '';
    await fetch(process.env.CLOCKWORK_CORE_URL + '/ingest/events', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.CLOCKWORK_INGEST_TOKEN }, body: JSON.stringify({ source: 'locked', events: [{ sourceId: crypto.createHash('sha256').update(k).digest('hex') }], seesOthers: Object.keys(process.env).filter(n => n.startsWith('CLOCKWORK_SECRET_')) }) });
    console.log('started'); setInterval(() => {}, 1000);`);
  const c2 = lib.loadConfig(); c2.extractors.locked = { enabled: true }; lib.saveConfig(c2);
  // Run the supervisor without its own core: point it at the stub by starting only the extractor half through the real entry point.
  const child = spawn(process.execPath, ['-e', `
    import('${path.join(lib.ROOT, 'cli', 'supervisor.mjs')}').then(async m => { await m.supervise({ startCore: false }); });`], { env: { ...process.env, CLOCKWORK_DATA: DATA, CLOCKWORK_SECRETS: 'file' }, stdio: 'ignore' });
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
  try {
    assert.ok(await until(() => got.some(g => g.body.source === 'mine' && g.body.events?.length === 1)), 'the template extractor delivered its item');
    const first = got.find(g => g.body.source === 'mine'); assert.equal(first.url, '/ingest/events'); assert.equal(first.auth, 'Bearer ' + c.tokens.ingest);
    const st = lib.readState(); assert.equal(st.processes.mine.state, 'running'); assert.match(st.processes.scorer.state, /python environment missing/);
    assert.ok(!JSON.stringify(st).includes(c.tokens.ingest), 'state file holds no tokens');
    assert.ok(await until(() => lib.readState().processes.locked?.state?.startsWith('needs connecting')), 'an extractor whose key is missing waits; it is not started without it');
    assert.ok(!got.some(g => g.body.source === 'locked'));
    const secrets = await import('../secrets.mjs'); process.env.CLOCKWORK_SECRETS = 'file'; secrets.setSecret('locked', 'token', KEY); delete process.env.CLOCKWORK_SECRETS;
    assert.ok(await until(() => got.some(g => g.body.source === 'locked'), 45000), 'once the key is saved it starts by itself');
    const fromLocked = got.find(g => g.body.source === 'locked'), crypto = await import('node:crypto');
    assert.equal(fromLocked.body.events[0].sourceId, crypto.createHash('sha256').update(KEY).digest('hex'), 'it was handed its key'); assert.deepEqual(fromLocked.body.seesOthers, ['CLOCKWORK_SECRET_TOKEN'], 'and no other extractor\'s');
    assert.ok(!JSON.stringify(lib.readState()).includes(KEY), 'the state file holds no key');
    for (const f of fs.readdirSync(lib.paths.logs())) assert.ok(!fs.readFileSync(path.join(lib.paths.logs(), f), 'utf8').includes(KEY), `${f} holds no key`);
    const pid = st.processes.mine.pid; cw('disable', 'mine');
    assert.ok(await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 25000), 'a disabled extractor is stopped without a restart');
    assert.equal(lib.readState().processes.mine, undefined);
  } finally { child.kill('SIGTERM'); await new Promise(r => child.on('exit', r)); core.close(); }
  assert.equal(lib.supervisorAlive(), 0);
});

test('upgrade: sees newer published changes, moves forward only by fast-forward, and refuses when this copy was edited or has diverged', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-up-')), origin = path.join(tmp, 'origin.git'), author = path.join(tmp, 'author'), copy = path.join(tmp, 'copy');
  const git = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, a.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
  const publish = (file, text, msg) => { fs.writeFileSync(path.join(author, file), text); git(author, 'add', '-A'); git(author, 'commit', '-q', '-m', msg); git(author, 'push', '-q', 'origin', 'HEAD:main'); };
  try {
    fs.mkdirSync(origin); git(origin, 'init', '-q', '--bare', '-b', 'main'); fs.mkdirSync(author); git(author, 'init', '-q', '-b', 'main'); git(author, 'remote', 'add', 'origin', origin);
    publish('a.txt', 'one', 'first'); git(tmp, 'clone', '-q', origin, copy);
    assert.equal(lib.upgradeState(tmp).state, 'not-git', 'a folder that is not the top of a checkout');
    assert.equal(lib.upgradeState(copy).state, 'current');
    publish('a.txt', 'two', 'second change'); publish('install.sh', '#!/bin/sh', 'installer changed');
    let st = lib.upgradeState(copy); assert.equal(st.state, 'behind'); assert.equal(st.behind, 2); assert.match(st.log.join('\n'), /second change/); assert.equal(st.reinstall, true);
    assert.equal(fs.readFileSync(path.join(copy, 'a.txt'), 'utf8'), 'one', 'looking changes nothing');
    fs.writeFileSync(path.join(copy, 'a.txt'), 'edited here'); st = lib.upgradeState(copy); assert.equal(st.state, 'dirty'); assert.deepEqual(st.files, ['a.txt']);
    git(copy, 'checkout', '-q', '--', 'a.txt');
    assert.ok(lib.applyUpgrade(copy).ok); assert.equal(fs.readFileSync(path.join(copy, 'a.txt'), 'utf8'), 'two'); assert.equal(lib.upgradeState(copy).state, 'current');
    publish('b.txt', 'x', 'docs only'); assert.equal(lib.upgradeState(copy).reinstall, false, 'no reinstall when no dependency file moved'); assert.ok(lib.applyUpgrade(copy).ok);
    // Published history rewritten (or local commits): never merged or reset for the user.
    git(author, 'commit', '-q', '--amend', '-m', 'rewritten'); git(author, 'push', '-q', '--force', 'origin', 'HEAD:main');
    st = lib.upgradeState(copy); assert.equal(st.state, 'diverged'); assert.ok(!lib.applyUpgrade(copy).ok, 'a fast-forward is impossible, so nothing moves');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('version: one number, shared by the command, the core and the changelog', () => {
  const v = lib.version(); assert.match(v, /^\d+\.\d+\.\d+$/); assert.match(cw('version').stdout, new RegExp(`^Clockwork ${v.replaceAll('.', '\\.')}`));
  assert.match(fs.readFileSync(path.join(lib.ROOT, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## ${v.replaceAll('.', '\\.')} `, 'm'), 'the changelog has an entry for this version');
});

test('demo: made-up messages reach a connected agent, a heads-up fires, and the real install is left alone', { skip: !fs.existsSync(path.join(lib.ROOT, 'core', 'node_modules')) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-demo-')), port = 4700 + Math.floor(Math.random() * 200), before = fs.readFileSync(lib.paths.config(), 'utf8');
  const child = spawn(process.execPath, [CLI, 'demo', '--every=1'], { env: { ...process.env, CLOCKWORK_DATA: DATA, CLOCKWORK_DEMO_DATA: dir, CLOCKWORK_DEMO_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
  try {
    assert.ok(await until(() => /made-up message\(s\) so far/.test(out)), 'the demo started: ' + out);
    const token = fs.readFileSync(path.join(dir, 'agent-token'), 'utf8').trim(); assert.ok(!out.includes(token), 'the token is never printed');
    const tool = async (name, args = {}) => JSON.parse((await (await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result.content[0].text);
    let s = await tool('get_setup_status'); assert.equal(s.finished, false); assert.equal(s.steps.find(x => x.step === 'feeds').done, true);
    const items = (await tool('get_items_to_label')).items; assert.ok(items.length >= 5);
    assert.ok((await tool('get_heads_up_updates')).items.some(i => /School office/.test(i.headsUpWhy)), 'the school message raised a heads-up');
    await tool('get_urgent_updates'); await tool('submit_labels', { labels: [{ id: items[0].id, bucket: 'later', reason: 'made up' }] });
    assert.equal((await tool('get_setup_status')).finished, true);
    assert.ok(await until(() => /Setup is finished/.test(out)), 'the demo says so when the agent has done everything');
    assert.equal(fs.readFileSync(lib.paths.config(), 'utf8'), before, 'the real config is untouched'); assert.ok(!fs.existsSync(path.join(DATA, 'clockwork.db')));
  } finally { child.kill('SIGTERM'); await new Promise(r => child.on('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); }
  assert.ok(await until(() => fetch(`http://127.0.0.1:${port}/health`).then(() => false, () => true), 5000), 'stopping the demo stops its core');
});
