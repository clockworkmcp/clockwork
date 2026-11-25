// Where the keys to the user's accounts are kept: app passwords and API tokens that `clockwork connect` asks for.
// They are never written into Clockwork's data folder in the clear when there is somewhere better:
//   1. An environment variable, CLOCKWORK_SECRET_<EXTRACTOR>_<NAME>, for machines whose host has its own secret store
//      (`fly secrets`, Docker or Kubernetes secrets). Read-only from here: the host owns it.
//   2. The macOS Keychain, through Apple's own `security` program. Encrypted with the user's login password, absent from
//      backups of the data folder, and not something a program finds by reading files.
//   3. Elsewhere, a file only the user can read, and `clockwork connect` says so.
// None of this protects against a program already running as the user: an extractor has to be handed its key without
// the user present, so anything running as the user can ask for it the same way. It protects the key at rest.
import crypto from 'node:crypto'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { dataDir, writePrivate } from './lib.mjs';

export const SECRET_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const upper = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '_');
/** The variable a host's secret store sets for one secret, and the one the extractor is handed it in. */
export const hostVar = (extractor, name) => `CLOCKWORK_SECRET_${upper(extractor)}_${upper(name)}`;
export const extractorVar = name => `CLOCKWORK_SECRET_${upper(name)}`;

// The absolute path, so nothing earlier on PATH can stand in for Apple's program. Tests name a stand-in.
const SECURITY = () => process.env.CLOCKWORK_SECURITY_BIN || '/usr/bin/security';
export const backend = () => process.env.CLOCKWORK_SECRETS === 'file' || process.env.CLOCKWORK_SECRETS === 'keychain' ? process.env.CLOCKWORK_SECRETS : process.platform === 'darwin' ? 'keychain' : 'file';
export const backendName = () => backend() === 'keychain' ? 'your macOS Keychain' : `a file only you can read (${path.join(dataDir(), 'secrets')}); this machine has no keychain Clockwork can use`;

/** One Keychain item per secret. Installs with their own data folder (the demo, tests) get their own items. */
const service = extractor => { const d = path.resolve(dataDir()), usual = path.join(os.homedir(), '.clockwork', 'v2'); return `dev.clockwork.${extractor}${d === usual ? '' : '.' + crypto.createHash('sha256').update(d).digest('hex').slice(0, 10)}`; };
const fileOf = extractor => path.join(dataDir(), 'secrets', extractor + '.json');
const readFileStore = extractor => { try { return JSON.parse(fs.readFileSync(fileOf(extractor), 'utf8')); } catch { return {}; } };
const safe = (extractor, name) => { if (!SECRET_NAME.test(extractor) || !SECRET_NAME.test(name)) throw new Error('not a secret name'); };

/** The saved value, or null. Never logged, never put in an error. */
export function getSecret(extractor, name) {
  safe(extractor, name);
  const fromHost = process.env[hostVar(extractor, name)]; if (fromHost) return fromHost;
  if (backend() === 'file') return readFileStore(extractor)[name] ?? null;
  const r = spawnSync(SECURITY(), ['find-generic-password', '-s', service(extractor), '-a', name, '-w'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout ? r.stdout.replace(/\r?\n$/, '') : readFileStore(extractor)[name] ?? null;   // the file is where it goes when the Keychain is not used
}

/** A key the user saved in a file by hand, before Clockwork asked for it itself. */
export const legacyValue = file => { try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; } };
/** What an extractor is handed, and what is still missing. A key still in its old file counts as there: the extractor reads that itself. */
export function secretsFor(extractor, secrets = []) {
  const env = {}, missing = [], inFiles = [];
  for (const s of secrets) { const v = getSecret(extractor, s.name); if (v) env[extractorVar(s.name)] = v; else if (s.file && legacyValue(s.file)) inFiles.push(s); else if (!s.optional) missing.push(s.name); }
  return { env, missing, inFiles };
}

/** Save a value. Throws when it could not be saved and read back; the message never holds the value. */
export function setSecret(extractor, name, value) {
  safe(extractor, name);
  if (typeof value !== 'string' || !value || /[^\x20-\x7e]/.test(value)) throw new Error('a secret must be plain letters, digits and symbols on one line');
  if (process.env[hostVar(extractor, name)]) throw new Error(`${hostVar(extractor, name)} is set on this machine, so the value comes from there; change it in your host's secret store`);
  if (backend() === 'file') { writePrivate(fileOf(extractor), JSON.stringify({ ...readFileStore(extractor), [name]: value })); return; }
  // The value goes to `security` on its standard input, as hexadecimal, so it never appears in a command line that other programs can list.
  spawnSync(SECURITY(), ['-i'], { input: `add-generic-password -U -s ${service(extractor)} -a ${name} -X ${Buffer.from(value, 'latin1').toString('hex')}\n`, encoding: 'utf8' });
  if (getSecret(extractor, name) !== value) throw new Error('the Keychain did not keep it (is your login keychain unlocked?). To keep it in a file only you can read instead, run the same command with CLOCKWORK_SECRETS=file in front');
}

export function deleteSecret(extractor, name) {
  safe(extractor, name);
  if (backend() === 'file') { const all = readFileStore(extractor); if (!(name in all)) return; delete all[name]; if (Object.keys(all).length) writePrivate(fileOf(extractor), JSON.stringify(all)); else fs.rmSync(fileOf(extractor), { force: true }); return; }
  spawnSync(SECURITY(), ['delete-generic-password', '-s', service(extractor), '-a', name], { stdio: 'ignore' });
}

/** Files the user saved by hand hold keys too: make sure nobody else on this machine can read them. Returns what was tightened. */
export function tighten(dir) {
  const fixed = [];
  try { if (fs.statSync(dir).mode & 0o077) { fs.chmodSync(dir, 0o700); fixed.push(dir); } for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f), st = fs.lstatSync(p); if (st.isFile() && st.mode & 0o077) { fs.chmodSync(p, 0o600); fixed.push(p); } } } catch {}
  return fixed;
}
