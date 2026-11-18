// Triage cascade: rules -> student (only where it is trained and confident) -> teacher -> otherwise hold as "later".
// Invariant: uncertainty never becomes "ignore".
import { itemText, unseenKind } from './features.mjs';
import { teach, teacherConfigured } from './teacher.mjs';
import { loadRules, matchRules } from './headsup.mjs';

const STUDENT_URL = process.env.CLOCKWORK_STUDENT_URL || 'http://127.0.0.1:4601';
const MARGIN = Number(process.env.CLOCKWORK_STUDENT_MARGIN || 0.8);       // student keeps an item only above this top-two margin
const URGENT_FLOOR = Number(process.env.CLOCKWORK_URGENT_FLOOR || 0.05);  // any urgent probability above this escalates
const SCORE_BATCH = Number(process.env.CLOCKWORK_SCORE_BATCH || 40);
const TEACHER_BATCH = Number(process.env.CLOCKWORK_TEACHER_BATCH || 20);
const MIN_PROVEN = Number(process.env.CLOCKWORK_GRADUATE_MIN || 30);          // agent-checked predictions needed before the student may decide
const MIN_AGREEMENT = Number(process.env.CLOCKWORK_GRADUATE_AGREEMENT || 0.9);
const NO_CONTENT = new Set(['protocol', 'empty', 'reaction', 'sticker']);
const BACKFILL_AFTER = Number(process.env.CLOCKWORK_BACKFILL_HOURS || 48) * 3600e3; // history older than this when it arrived is filed, not classified
const HEADSUP_GAP = Number(process.env.CLOCKWORK_HEADSUP_GAP_MIN || 60) * 60e3;            // at most one heads-up per conversation in this time
const HEADSUP_MAX_AGE = Number(process.env.CLOCKWORK_URGENT_MAX_AGE_HOURS || 12) * 3600e3;  // the same age limit as urgent deliveries

export function rule(e) {
  if (e.direction === 'outgoing') return { bucket: 'ignore', reason: 'own message' };
  if (e.metadata?.promoted) return { bucket: 'ignore', reason: 'promoted post' };
  // An unknown message type is not "no content": it may be something the connector cannot read yet. Only types known to be empty are dropped here.
  if (NO_CONTENT.has(e.kind) || (e.kind.startsWith('other') && !e.text && !unseenKind(e))) return { bucket: 'ignore', reason: 'no content' };
  // Linking an account replays months of old messages. They are kept as context and training material, but nobody
  // needs them triaged, so they never reach the student or the teacher. They stay out of "ignore": nothing judged them.
  if (e.feed === 'history' && e.source_time && Date.parse(e.source_time) < (e.created_at ?? Date.now()) - BACKFILL_AFTER) return { bucket: 'later', reason: 'old history', stage: 'backfill' };
  return null;
}

export async function scoreWithStudent(events, fetchImpl = fetch) {
  // In small batches: a large one can outlast the timeout on a small machine, and unscored items go to the teacher.
  let out = null;
  for (let i = 0; i < events.length; i += SCORE_BATCH) {
    try {
      const r = await fetchImpl(`${STUDENT_URL}/score`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: events.slice(i, i + SCORE_BATCH).map(e => ({ id: e.id, source: e.source, text: itemText(e) })) }), signal: AbortSignal.timeout(60000) });
      if (!r.ok) break;
      const part = await r.json(); // { model, trainedSources: [...], scores: { id: {urgent, later, ignore} }, urgentScores, urgentThresholds }
      out = out ? { ...part, scores: { ...out.scores, ...part.scores }, urgentScores: { ...out.urgentScores, ...part.urgentScores } } : part;
    } catch { break; } // the student is down or overloaded: stop asking; what was not scored is treated as unscored
  }
  return out;
}

export function studentVerdict(e, p, trainedSources, margin = MARGIN, urgentFloor = URGENT_FLOOR, urgentScore = null, urgentThreshold = null) {
  if (!p || !trainedSources.includes(e.source)) return null;
  // The urgent detector only ever escalates: anything it flags goes to the teacher.
  if (urgentScore !== null && urgentThreshold !== null && urgentScore >= urgentThreshold) return null;
  const ranked = Object.entries(p).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] - ranked[1][1] < margin) return null;
  if (ranked[0][0] !== 'urgent' && p.urgent > urgentFloor) return null;
  if (ranked[0][0] === 'urgent') return null; // an interruption is always confirmed by the teacher
  return { bucket: ranked[0][0], p };
}

/** Who labels what the student is unsure about: 'builtin' (a model called by this server) or 'agent' (the user's own agent, over MCP). */
export const teacherMode = () => process.env.CLOCKWORK_TEACHER_MODE === 'agent' ? 'agent' : 'builtin';

/** How the student's confident predictions have held up against the agent's and user's own labels for one source. */
export function readiness(store, source, margin = MARGIN, urgentFloor = URGENT_FLOOR) {
  const rows = store.judged(source); let kept = 0, agreed = 0;
  for (const r of rows) {
    const v = studentVerdict({ source }, { urgent: r.p_urgent ?? 0, later: r.p_later ?? 0, ignore: r.p_ignore ?? 0 }, [source], margin, urgentFloor);
    if (v) { kept++; if (v.bucket === r.label) agreed++; }
  }
  const override = store.kv.get(`shadow:${source}`) || 'auto';
  const proven = kept >= MIN_PROVEN && agreed / kept >= MIN_AGREEMENT;
  return { judged: rows.length, confidentPredictions: kept, agreement: kept ? Math.round(agreed / kept * 1000) / 1000 : null,
    needed: { confidentPredictions: MIN_PROVEN, agreement: MIN_AGREEMENT }, shadow: override, decidesAlone: override === 'off' || (override === 'auto' && proven) };
}

/** Process up to `limit` undecided events. Returns counts per stage. */
export async function runOnce(store, { limit = 200, student = scoreWithStudent, mode = teacherMode(), teacher = mode === 'builtin' && teacherConfigured() ? teach : null,
  headsUpGapMs = HEADSUP_GAP, headsUpMaxAgeMs = HEADSUP_MAX_AGE } = {}) {
  const counts = { rule: 0, student: 0, teacher: 0, pending_teacher: 0, deferred: 0, errors: 0 };
  const events = store.undecided(limit); if (!events.length) return counts;
  const rest = [];
  for (const e of events) {
    const r = rule(e);
    if (r) { store.decide(e.id, { stage: 'rule', ...r }); counts.rule++; } else rest.push(e);
  }
  const escalate = [];
  const scored = rest.length ? await student(rest) : null;
  // Neither classifier reachable: leave the items undecided and try again on the next pass.
  if (rest.length && !scored && !teacher && mode === 'builtin') { counts.deferred = rest.length; return counts; }
  // Shadow mode: with the agent as teacher, the student decides a source alone only once its confident
  // predictions have matched the agent's labels often enough. Until then it predicts and the agent labels.
  const alone = new Map(); const decidesAlone = src => { if (!alone.has(src)) alone.set(src, mode !== 'agent' || readiness(store, src).decidesAlone); return alone.get(src); };
  const rules = mode === 'agent' ? loadRules(store) : [];
  for (const e of rest) {
    const p = scored?.scores?.[e.id], us = scored?.urgentScores?.[e.id] ?? null, ut = scored?.urgentThresholds?.[e.source] ?? scored?.urgentThreshold ?? null;
    const v = studentVerdict(e, p, scored?.trainedSources ?? [], MARGIN, URGENT_FLOOR, us, ut);
    // Heads-up: a rule the agent set matched, or the urgent detector flagged it. Either way the agent sees it, so the student does not file it alone.
    const matched = matchRules(rules, e)[0];
    const headsUp = matched ? `rule: ${matched}` : us !== null && ut !== null && us >= ut ? 'model' : null;
    // A picture, voice note or file without a caption was not reviewed by anyone: the local model never files it on its own.
    if (v && !matched && decidesAlone(e.source) && !(unseenKind(e) && !e.text)) { store.decide(e.id, { bucket: v.bucket, stage: 'student', p, model: scored.model }); counts.student++; }
    else escalate.push({ e, p, headsUp });
  }
  if (mode === 'agent') {
    // Held where the user would still see it. The agent's labelling queue lists these first, likeliest-urgent on top.
    counts.heads_up = 0;
    for (const { e, p, headsUp } of escalate) {
      store.decide(e.id, { bucket: 'later', stage: 'pending_agent', p, reason: 'awaiting agent label', model: scored?.model });
      if (headsUp && wantsHeadsUp(store, e, headsUpGapMs, headsUpMaxAgeMs)) { store.raiseHeadsUp(e.id, headsUp); counts.heads_up++; }
    }
    counts.pending_agent = escalate.length; return counts;
  }
  await escalateToTeacher(store, escalate, teacher, counts);
  return counts;
}

/** A heads-up wakes the agent, so it is held back when it would only repeat itself: the message is too old to act on,
 *  the user has already written in that conversation since, or the agent was woken for the same conversation recently. */
function wantsHeadsUp(store, e, gapMs, maxAgeMs) {
  const sent = Date.parse(e.source_time || e.observed_at), now = Date.now();
  if (!(sent > now - maxAgeMs)) return false;
  if (store.answered(e)) return false;
  return !(gapMs > 0) || !store.recentHeadsUp(e, now - gapMs);
}

const MAX_ATTEMPTS = 3;                                                             // per item, then stop asking
const DAILY_CAP = Number(process.env.CLOCKWORK_TEACHER_DAILY_ITEMS || 3000);           // spend guard: teacher labels per UTC day

function teacherBudget(store) {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const used = store.db.prepare(`SELECT COUNT(*) n FROM labels WHERE source='teacher' AND created_at>=?`).get(dayStart.getTime()).n;
  return Math.max(0, DAILY_CAP - used);
}

/** Ask the teacher about a batch. If the batch fails, ask item by item so one bad item cannot block the rest. */
async function askTeacher(store, teacher, events, counts) {
  const answers = new Map(); let model;
  const ask = async group => {
    const res = await teacher(group, e => store.threadContext(e));
    model = res.model; for (const [id, d] of res.decisions) answers.set(id, d);
  };
  try { await ask(events); }
  catch (err) {
    counts.errors++; counts.lastError = err.message;
    if (events.length > 1) for (const e of events) { try { await ask([e]); } catch (err2) { counts.errors++; counts.lastError = err2.message; } }
  }
  return { answers, model };
}

async function escalateToTeacher(store, escalate, teacher, counts, alreadyHeld = false) {
  let budget = teacher ? teacherBudget(store) : 0;
  if (teacher && !budget && escalate.length) counts.lastError = 'teacher daily cap reached';
  for (let i = 0; i < escalate.length; i += TEACHER_BATCH) {
    const batch = escalate.slice(i, i + TEACHER_BATCH);
    const askable = batch.slice(0, budget).map(x => x.e); budget -= askable.length;
    const { answers, model } = askable.length ? await askTeacher(store, teacher, askable, counts) : { answers: new Map() };
    for (const { e, p } of batch) {
      const d = answers.get(e.id);
      if (d) {
        store.decide(e.id, { bucket: d.bucket, stage: 'teacher', p, reason: d.reason, model });
        store.label(e.id, d.bucket, 'teacher', d.confidence, d.reason); counts.teacher++; continue;
      }
      // No answer. Hold it where the user will still see it, and give up asking after a few failed attempts.
      const asked = askable.includes(e);
      const attempts = Number(store.kv.get(`teacher_attempts:${e.id}`) || 0) + (asked ? 1 : 0);
      if (asked) store.kv.set(`teacher_attempts:${e.id}`, attempts);
      const stage = attempts >= MAX_ATTEMPTS ? 'teacher_failed' : 'pending_teacher';
      if (alreadyHeld && stage === 'pending_teacher') { counts.pending_teacher++; continue; }
      const held = alreadyHeld ? store.get(e.id) : null;
      const bucket = held?.bucket ?? (p && p.urgent > 0.5 ? 'urgent' : 'later');
      store.decide(e.id, { bucket, stage, p, reason: stage === 'teacher_failed' ? 'teacher could not classify' : 'awaiting teacher' });
      counts[stage] = (counts[stage] || 0) + 1;
    }
  }
}

/** Retry items that were held because no teacher was available. */
export async function drainPending(store, { limit = 100, teacher = teacherConfigured() ? teach : null, mode = teacherMode(),
  fallbackMinutes = Number(process.env.CLOCKWORK_AGENT_FALLBACK_MINUTES || 0) } = {}) {
  const counts = { teacher: 0, pending_teacher: 0, errors: 0 };
  if (!teacher) return counts;
  // With the agent as teacher, the built-in teacher is only a safety net: it takes items the agent has left
  // unlabelled for `fallbackMinutes` (0 = never).
  if (mode === 'agent' && !(fallbackMinutes > 0)) return counts;
  const events = mode === 'agent' ? store.pendingAgent(fallbackMinutes * 60e3, limit) : store.pendingTeacher(limit);
  await escalateToTeacher(store, events.map(e => ({ e, p: null })), teacher, counts, true);
  return counts;
}

/** Spot-check the student: the teacher re-labels a random sample of items the student decided on its own.
 *  Disagreements are corrected, and every answer becomes a label, so the student is measured and trained on real traffic. */
export async function audit(store, { n = 40, source, teacher = teacherConfigured() ? teach : null } = {}) {
  if (!teacher) return { audited: 0, reason: 'no teacher' };
  const rows = store.db.prepare(`SELECT e.* FROM events e JOIN decisions d ON d.event_id=e.id
    WHERE d.stage='student' ${source ? 'AND e.source=?' : ''} AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.event_id=e.id) ORDER BY RANDOM() LIMIT ?`)
    .all(...(source ? [String(source)] : []), Math.max(1, Math.min(Number(n) || 40, Math.min(200, teacherBudget(store)))));
  const events = rows.map(e => ({ ...e, metadata: e.metadata ? JSON.parse(e.metadata) : undefined, is_group: !!e.is_group }));
  const out = { audited: 0, agreed: 0, changed: {}, errors: 0 };
  for (let i = 0; i < events.length; i += TEACHER_BATCH) {
    const { answers, model } = await askTeacher(store, teacher, events.slice(i, i + TEACHER_BATCH), out);
    for (const e of events.slice(i, i + TEACHER_BATCH)) {
      const d = answers.get(e.id); if (!d) continue;
      const was = store.get(e.id).bucket; out.audited++;
      store.label(e.id, d.bucket, 'teacher', d.confidence, d.reason);
      if (was === d.bucket) out.agreed++;
      else { out.changed[`${was}->${d.bucket}`] = (out.changed[`${was}->${d.bucket}`] || 0) + 1; store.decide(e.id, { bucket: d.bucket, stage: 'teacher', reason: d.reason, model }); }
    }
  }
  return out;
}
