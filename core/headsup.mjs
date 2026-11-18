// Heads-up rules: messages the user's agent asked to see as they arrive. A match wakes the agent, never the user, and never
// changes an item's bucket: the agent reads the item, labels it, and decides whether the user needs to hear about it.
export const RULES_KEY = 'headsup:rules';
const MAX_RULES = 200, MAX_LIST = 200, MAX_STR = 200;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LISTS = ['chats', 'senders', 'senderContains', 'anyWords', 'allWords', 'notWords', 'kinds'];
const FIELDS = new Set(['name', 'why', 'source', 'isGroup', 'hours', 'days', ...LISTS]);

const bad = m => Object.assign(new Error(m), { status: 400 });
const str = (v, max = MAX_STR) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Check a whole list of rules. Throws an error naming the rule and field at fault; returns the list unchanged. */
export function validateRules(list) {
  if (!Array.isArray(list)) throw bad('rules must be a list');
  if (list.length > MAX_RULES) throw bad(`at most ${MAX_RULES} rules`);
  const names = new Set();
  list.forEach((r, i) => {
    const at = `rule ${i + 1}${r && typeof r.name === 'string' ? ` ("${r.name.slice(0, 40)}")` : ''}`;
    const no = (f, m) => { throw bad(`${at}: ${f} ${m}`); };
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad(`${at}: must be an object`);
    for (const k of Object.keys(r)) if (!FIELDS.has(k)) no(k, 'is not a known field');
    if (!str(r.name, 80)) no('name', 'must be a short non-empty string');
    if (names.has(r.name)) no('name', 'is used by an earlier rule'); names.add(r.name);
    if (r.why !== undefined && !str(r.why)) no('why', `must be a non-empty string of at most ${MAX_STR} characters`);
    if (r.source !== undefined && !str(r.source, 40)) no('source', 'must be a short string');
    if (r.isGroup !== undefined && typeof r.isGroup !== 'boolean') no('isGroup', 'must be true or false');
    for (const f of LISTS) if (r[f] !== undefined && !(Array.isArray(r[f]) && r[f].length && r[f].length <= MAX_LIST && r[f].every(s => str(s))))
      no(f, `must be a list of 1 to ${MAX_LIST} non-empty strings of at most ${MAX_STR} characters`);
    if (r.hours !== undefined) {
      const [a, b] = Array.isArray(r.hours) ? r.hours : [];
      if (!Array.isArray(r.hours) || r.hours.length !== 2 || !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 23 || b < 0 || b > 24 || a === b) no('hours', 'must be [from, to] whole hours, from 0-23, to 0-24, not equal');
    }
    if (r.days !== undefined && !(Array.isArray(r.days) && r.days.length && r.days.length <= 7 && r.days.every(d => DAYS.includes(d)))) no('days', `must be a list of ${DAYS.join(', ')}`);
    if (!Object.keys(r).some(k => k !== 'name' && k !== 'why')) no('rule', 'needs at least one condition, or it would match every message');
  });
  return list;
}

const formats = new Map();
function localTime(iso) {
  const ms = Date.parse(iso); if (!Number.isFinite(ms)) return null;
  const tz = process.env.CLOCKWORK_TZ || undefined;
  if (!formats.has(tz)) {
    let f; try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }); }
    catch { f = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', weekday: 'short' }); } // unknown zone: the process zone
    formats.set(tz, f);
  }
  const parts = Object.fromEntries(formats.get(tz).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { hour: Number(parts.hour) % 24, day: parts.weekday.slice(0, 3).toLowerCase() };
}

const lower = s => String(s ?? '').toLowerCase();
function matches(r, e) {
  if (r.source !== undefined && r.source !== e.source) return false;
  if (r.isGroup !== undefined && r.isGroup !== !!e.is_group) return false;
  if (r.chats && !r.chats.includes(e.thread_id)) return false;
  if (r.senders && !r.senders.includes(e.author)) return false;
  if (r.senderContains) { const who = lower(`${e.author ?? ''} ${e.author_name ?? ''}`); if (!r.senderContains.some(s => who.includes(lower(s)))) return false; }
  if (r.anyWords || r.allWords || r.notWords) {
    const body = lower(`${e.metadata?.subject || ''}\n${e.text || ''}`), has = w => body.includes(lower(w));
    if (r.anyWords && !r.anyWords.some(has)) return false;
    if (r.allWords && !r.allWords.every(has)) return false;
    if (r.notWords && r.notWords.some(has)) return false;
  }
  if (r.kinds && !r.kinds.includes(e.kind)) return false;
  if (r.hours || r.days) {
    const t = localTime(e.source_time || e.observed_at); if (!t) return false;
    if (r.hours) { const [a, b] = r.hours; if (a < b ? !(t.hour >= a && t.hour < b) : !(t.hour >= a || t.hour < b)) return false; }
    if (r.days && !r.days.includes(t.day)) return false;
  }
  return true;
}

/** Names of the rules a stored message matches, in rule order. */
export const matchRules = (rules, e) => (rules || []).filter(r => matches(r, e)).map(r => r.name);

export function loadRules(store) {
  try { const l = JSON.parse(store.kv.get(RULES_KEY) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
}
export function saveRules(store, list) { store.kv.set(RULES_KEY, JSON.stringify(validateRules(list))); return list.length; }
