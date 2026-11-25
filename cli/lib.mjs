// Shared pieces of the local install: the config file, extractor manifests, and the login service definition.
import crypto from 'node:crypto'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = () => { const d = process.env.CLOCKWORK_DATA || path.join(os.homedir(), '.clockwork', 'v2'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const sub = (...p) => path.join(dataDir(), ...p);
export const paths = {
  config: () => sub('config.json'), agentToken: () => sub('agent-token'), state: () => sub('run', 'state.json'), pid: () => sub('run', 'supervisor.pid'),
  logs: () => sub('logs'), userExtractors: () => sub('extractors'), extractorData: n => sub('extractor-data', n), venvPython: () => sub('venv', 'bin', 'python'),
};
export const writePrivate = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file + '.tmp', text, { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

// ---- config -------------------------------------------------------------------------------------------------------
// graduateAgreement: how often the local model's confident calls must match the agent's before a source leaves shadow mode.
const DEFAULTS = { port: 4600, studentPort: 4601, teacherMode: 'agent', retrainHours: 24, graduateAgreement: 0.95, extractors: {} };
export function loadConfig() { const c = readJson(paths.config(), null); return c ? { ...DEFAULTS, ...c, extractors: { ...(c.extractors || {}) } } : null; }
export function saveConfig(c) { writePrivate(paths.config(), JSON.stringify(c, null, 2) + '\n'); return c; }
/** Create the config on first use. Tokens are generated here and never printed. */
export function initConfig({ tz } = {}) {
  let c = loadConfig(); const created = !c;
  if (!c) c = { ...DEFAULTS, tz: tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    tokens: Object.fromEntries(['admin', 'agent', 'ingest'].map(k => [k, crypto.randomBytes(32).toString('hex')])) };
  saveConfig(c); writePrivate(paths.agentToken(), c.tokens.agent + '\n');
  return { config: c, created };
}
export const coreUrl = c => `http://127.0.0.1:${c.port}`;

// ---- extractor manifests ------------------------------------------------------------------------------------------
// An extractor is a folder with `extractor.json` and a program that posts items to the core. See docs/EXTRACTORS.md.
export const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const isCmd = v => v && typeof v === 'object' && typeof v.command === 'string' && v.command && (v.args === undefined || (Array.isArray(v.args) && v.args.every(a => typeof a === 'string')));
/** Returns a list of problems; empty means the manifest is usable. */
export function manifestProblems(m) {
  const out = [];
  if (!m || typeof m !== 'object') return ['extractor.json is not a JSON object'];
  if (!NAME.test(m.name || '')) out.push('"name" must be lower-case letters, digits and dashes (up to 31 characters, starting with a letter)');
  if (typeof m.source !== 'string' || !/^[a-z][a-z0-9_-]{0,30}$/.test(m.source)) out.push('"source" must be a short lower-case name for where the items come from');
  if (!isCmd(m.run)) out.push('"run" must be { "command": "...", "args": [...] }');
  for (const k of ['install', 'build']) if (m[k] !== undefined && !isCmd(m[k])) out.push(`"${k}" must be { "command": "...", "args": [...] }`);
  if (m.env !== undefined && (typeof m.env !== 'object' || Object.entries(m.env).some(([k, v]) => !/^[A-Z][A-Z0-9_]*$/.test(k) || typeof v !== 'string'))) out.push('"env" must map upper-case names to strings');
  if (m.env && Object.keys(m.env).some(k => /^CLOCKWORK_(TOKEN|AGENT_TOKEN|INGEST_TOKEN|CORE_URL|DATA)$/.test(k) || k === 'ANTHROPIC_API_KEY')) out.push('"env" may not set Clockwork\'s own tokens or addresses');
  if (m.ready !== undefined && typeof m.ready?.file !== 'string') out.push('"ready" must be { "file": "..." }');
  const c = m.connect;
  if (c !== undefined && !(c && ((c.type === 'open' && typeof c.url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(c.url)) || (c.type === 'command' && isCmd(c)) || (c.type === 'flag' && typeof c.file === 'string'))))
    out.push('"connect" must be { type: "open", url: "http://127.0.0.1:..." }, { type: "command", command, args } or { type: "flag", file }');
  if (m.restartSeconds !== undefined && !(Number(m.restartSeconds) >= 10)) out.push('"restartSeconds" must be at least 10');
  return out;
}
const fill = (s, vars) => String(s).replace(/\{(data|dir|extractorData)\}/g, (_, k) => vars[k]);
/** Every extractor known to this install: the ones shipped with Clockwork and the ones the user added. */
export function listExtractors(config = loadConfig() || DEFAULTS) {
  const out = [];
  for (const [base, builtin] of [[path.join(ROOT, 'extractors'), true], [paths.userExtractors(), false]]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).sort()) {
      const dir = path.join(base, d), file = path.join(dir, 'extractor.json');
      if (!fs.existsSync(file)) continue;                    // `templates/` holds starting points, not extractors
      const m = readJson(file, null), problems = manifestProblems(m);
      if (!builtin && m && m.name !== d) problems.push(`folder is "${d}" but the manifest is named "${m.name}"`);
      if (!builtin && out.some(x => x.builtin && x.name === m?.name)) problems.push('that name belongs to a built-in extractor');
      if (!builtin && m?.cwd !== undefined) problems.push('"cwd" is only for built-in extractors: an added extractor runs in its own folder');
      out.push({ name: m?.name || d, dir, builtin, manifest: m, problems, enabled: !problems.length && config.extractors?.[m.name]?.enabled === true });
    }
  }
  return out;
}
export const findExtractor = (name, config) => listExtractors(config).find(x => x.name === name);
/** Paths and environment for one extractor, with {data}, {dir} and {extractorData} filled in. */
export function resolveExtractor(x, config) {
  const vars = { data: dataDir(), dir: path.resolve(x.dir, x.manifest.cwd || '.'), extractorData: paths.extractorData(x.name) };
  const m = x.manifest, cmd = c => c && { command: fill(c.command, vars), args: (c.args || []).map(a => fill(a, vars)) };
  return { cwd: vars.dir, run: cmd(m.run), install: cmd(m.install), build: cmd(m.build), ready: m.ready && fill(m.ready.file, vars),
    connect: m.connect && { ...m.connect, ...(m.connect.type === 'command' ? cmd(m.connect) : {}), ...(m.connect.file ? { file: fill(m.connect.file, vars) } : {}) },
    env: extractorEnv(config, x.name, Object.fromEntries(Object.entries(m.env || {}).map(([k, v]) => [k, fill(v, vars)]))) };
}

// ---- environments: each process gets only what it needs -----------------------------------------------------------
const PASS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TZ'];
export const baseEnv = () => Object.fromEntries(PASS.filter(k => process.env[k]).map(k => [k, process.env[k]]));
/** Extractors can write items and nothing else: they get the ingest token, never the admin or agent token or a model key. */
export const extractorEnv = (c, name, extra = {}) => ({ ...baseEnv(), ...extra, CLOCKWORK_CORE_URL: coreUrl(c), CLOCKWORK_INGEST_TOKEN: c.tokens.ingest, CLOCKWORK_EXTRACTOR_DATA: paths.extractorData(name) });
export const coreEnv = c => ({ ...baseEnv(), CLOCKWORK_DATA: dataDir(), CLOCKWORK_HOST: '127.0.0.1', CLOCKWORK_PORT: String(c.port), CLOCKWORK_STUDENT_URL: `http://127.0.0.1:${c.studentPort}`,
  CLOCKWORK_TOKEN: c.tokens.admin, CLOCKWORK_AGENT_TOKEN: c.tokens.agent, CLOCKWORK_INGEST_TOKEN: c.tokens.ingest, CLOCKWORK_TEACHER_MODE: c.teacherMode, CLOCKWORK_TZ: c.tz || 'UTC', CLOCKWORK_GRADUATE_AGREEMENT: String(c.graduateAgreement ?? 0.95),
  ...(c.teacherMode === 'builtin' ? { CLOCKWORK_AGENT_TEACHER: '1' } : {}), ...(c.publicUrl ? { CLOCKWORK_PUBLIC_URL: c.publicUrl } : {}),
  ...(c.teacherMode === 'builtin' && process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}), ...(c.coreEnv || {}) });
export const studentEnv = c => ({ ...baseEnv(), CLOCKWORK_DATA: dataDir(), CLOCKWORK_STUDENT_PORT: String(c.studentPort), CLOCKWORK_TZ: c.tz || 'UTC',
  HF_HOME: process.env.CLOCKWORK_HF_HOME || path.join(dataDir(), 'student', 'hf'), TOKENIZERS_PARALLELISM: 'false', ...(c.studentEnv || {}) });
export const python = c => c.python || paths.venvPython();

// ---- start at login (macOS launchd) -------------------------------------------------------------------------------
export const LABEL = process.env.CLOCKWORK_SERVICE_LABEL || 'dev.clockwork.service';
export const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
const xml = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
export function plist({ node = process.execPath, cli = path.join(ROOT, 'cli', 'clockwork.mjs'), data = dataDir(), pathEnv = process.env.PATH || '/usr/bin:/bin' } = {}) {
  const log = path.join(data, 'logs', 'supervisor.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(LABEL)}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>CLOCKWORK_DATA</key><string>${xml(data)}</string><key>PATH</key><string>${xml(pathEnv)}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

export const readState = () => readJson(paths.state(), null);
export const supervisorAlive = () => { const pid = Number(readJson(paths.pid(), 0)); if (!pid) return 0; try { process.kill(pid, 0); return pid; } catch { return 0; } };

// ---- version and upgrades -----------------------------------------------------------------------------------------
export const version = () => readJson(path.join(ROOT, 'core', 'package.json'), {}).version || 'unknown';
const git = (root, ...a) => { const r = spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' }); return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
export const commitOf = (root = ROOT) => { const r = git(root, 'rev-parse', '--short', 'HEAD'); return r.ok ? r.out : null; };
/** Where this copy stands against the place it was cloned from. Fetches; changes no file. */
export function upgradeState(root = ROOT) {
  const top = git(root, 'rev-parse', '--show-toplevel'); if (!top.ok || fs.realpathSync(top.out) !== fs.realpathSync(root)) return { state: 'not-git' };
  const up = git(root, 'rev-parse', '--abbrev-ref', '@{upstream}'); if (!up.ok) return { state: 'no-upstream' };
  const f = git(root, 'fetch', '--quiet', up.out.split('/')[0]); if (!f.ok) return { state: 'offline', error: f.err.split('\n').pop() };
  const [ahead, behind] = git(root, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}').out.split(/\s+/).map(Number);
  if (!behind) return { state: 'current', ahead };
  if (ahead) return { state: 'diverged', ahead, behind, upstream: up.out };
  const dirty = git(root, 'status', '--porcelain', '--untracked-files=no').out; if (dirty) return { state: 'dirty', behind, files: dirty.split('\n').map(l => l.replace(/^\s*\S+\s+/, '')) };
  const changed = git(root, 'diff', '--name-only', 'HEAD', '@{upstream}').out.split('\n');
  return { state: 'behind', behind, upstream: up.out, log: git(root, 'log', '--no-decorate', '--format=%h %s', '-n', '20', 'HEAD..@{upstream}').out.split('\n'),
    // Only these files change what install.sh would do, so the slow reinstall is skipped when none of them moved.
    reinstall: changed.some(p => p === 'install.sh' || p === 'core/package-lock.json' || p === 'student/requirements.lock') };
}
/** Move this copy forward to what was fetched. Fast-forward only: it never merges and never discards anything. */
export const applyUpgrade = (root = ROOT) => git(root, 'merge', '--ff-only', '--quiet', '@{upstream}');
