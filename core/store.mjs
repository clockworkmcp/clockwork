// SQLite store: events, decisions (current triage state), labels (training signal).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

export const BUCKETS = ['urgent', 'later', 'ignore'];
export function dataDir() {
  const d = process.env.CLOCKWORK_DATA || path.join(os.homedir(), '.clockwork', 'v2');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d;
}
export function openStore(file = path.join(dataDir(), 'clockwork.db')) {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') fs.chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS events(
      id TEXT PRIMARY KEY, source TEXT NOT NULL, feed TEXT, thread_id TEXT, author TEXT, author_name TEXT,
      source_time TEXT, observed_at TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'incoming', is_group INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'text', text TEXT NOT NULL DEFAULT '', url TEXT, metadata TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, source_time);
    CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
    CREATE TABLE IF NOT EXISTS decisions(
      event_id TEXT PRIMARY KEY REFERENCES events(id), bucket TEXT NOT NULL, stage TEXT NOT NULL,
      p_urgent REAL, p_later REAL, p_ignore REAL, reason TEXT, model TEXT, decided_at INTEGER NOT NULL, delivered_at INTEGER);
    CREATE INDEX IF NOT EXISTS decisions_bucket ON decisions(bucket, decided_at);
    CREATE INDEX IF NOT EXISTS decisions_stage ON decisions(stage);
    CREATE TABLE IF NOT EXISTS labels(
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(id), bucket TEXT NOT NULL,
      source TEXT NOT NULL, confidence TEXT, reason TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS labels_event ON labels(event_id);
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions(
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
      cursor INTEGER NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_ok INTEGER, last_error TEXT, sent INTEGER NOT NULL DEFAULT 0);`);
  // Columns added after the first release: added in place to databases created before them.
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  for (const [table, col, type] of [['decisions', 'heads_up_at', 'INTEGER'], ['decisions', 'heads_up_reason', 'TEXT']])
    if (!has(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  db.exec('CREATE INDEX IF NOT EXISTS decisions_heads_up ON decisions(heads_up_at) WHERE heads_up_at IS NOT NULL');
  const q = {
    insert: db.prepare(`INSERT OR IGNORE INTO events(id,source,feed,thread_id,author,author_name,source_time,observed_at,direction,is_group,kind,text,url,metadata,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    undecided: db.prepare(`SELECT e.* FROM events e LEFT JOIN decisions d ON d.event_id=e.id WHERE d.event_id IS NULL ORDER BY e.created_at LIMIT ?`),
    pending: db.prepare(`SELECT e.* FROM events e JOIN decisions d ON d.event_id=e.id WHERE d.stage='pending_teacher' ORDER BY d.decided_at LIMIT ?`),
    decide: db.prepare(`INSERT INTO decisions(event_id,bucket,stage,p_urgent,p_later,p_ignore,reason,model,decided_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET bucket=excluded.bucket, stage=excluded.stage, p_urgent=COALESCE(excluded.p_urgent, p_urgent),
      p_later=COALESCE(excluded.p_later, p_later), p_ignore=COALESCE(excluded.p_ignore, p_ignore), reason=excluded.reason, model=excluded.model, decided_at=excluded.decided_at`),
    label: db.prepare(`INSERT INTO labels(event_id,bucket,source,confidence,reason,created_at) VALUES (?,?,?,?,?,?)`),
    get: db.prepare(`SELECT e.*, d.bucket, d.stage, d.reason, d.p_urgent, d.p_later, d.p_ignore FROM events e LEFT JOIN decisions d ON d.event_id=e.id WHERE e.id=?`),
    thread: db.prepare(`SELECT id, author, author_name, direction, source_time, text FROM events WHERE thread_id=? AND source=? AND source_time<? ORDER BY source_time DESC LIMIT ?`),
  };
  // True when the user wrote in the same thread after the item was sent. They have probably seen it; whether it is dealt with is a judgement.
  const ANSWERED = `EXISTS (SELECT 1 FROM events o WHERE o.thread_id=e.thread_id AND o.source=e.source AND o.direction='outgoing' AND o.source_time>COALESCE(e.source_time, e.observed_at))`;
  const row = e => e && { ...e, metadata: e.metadata ? JSON.parse(e.metadata) : undefined, is_group: !!e.is_group };
  return {
    db,
    /** Idempotent: returns ids that were new. */
    ingest(source, events) {
      const fresh = []; const now = Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const e of events) {
          if (!e || !e.sourceId) continue;
          const id = `${source}:${e.threadId && source !== 'x' ? e.threadId + ':' : ''}${e.sourceId}`;
          // Connectors mark records replayed from a history sync (`origin: "history:..."`) and, with several accounts, which one saw it.
          const feed = e.feed ?? (typeof e.origin === 'string' && e.origin.startsWith('history') ? 'history' : null);
          let meta = e.metadata ?? (e.account ? { account: String(e.account).slice(0, 40) } : null);
          // The name of the chat a message arrived in (a group's title), when the connector knows it.
          if (typeof e.chatName === 'string' && e.chatName.trim()) meta = { ...(meta || {}), chat: e.chatName.trim().slice(0, 80) };
          const r = q.insert.run(id, source, feed, e.threadId ?? null, e.author ?? null, e.authorName ?? null, e.sourceTime ?? null,
            e.observedAt ?? new Date(now).toISOString(), e.direction === 'outgoing' ? 'outgoing' : 'incoming', e.isGroup ? 1 : 0,
            e.kind ?? 'text', e.text ?? '', e.url ?? null, meta ? JSON.stringify(meta) : null, now);
          if (r.changes) fresh.push(id);
        }
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      return fresh;
    },
    /** Record chat names for a source and fill them in on messages already stored without one. Returns how many messages changed. */
    nameChats(source, chats) {
      const set = db.prepare(`UPDATE events SET metadata=json_set(COALESCE(metadata,'{}'),'$.chat',?) WHERE source=? AND thread_id=? AND COALESCE(json_extract(metadata,'$.chat'),'')!=?`);
      let changed = 0; db.exec('BEGIN IMMEDIATE');
      try {
        for (const c of chats) { const name = typeof c?.name === 'string' ? c.name.trim().slice(0, 80) : ''; if (name && c.threadId) changed += Number(set.run(name, source, String(c.threadId), name).changes); }
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      return changed;
    },
    undecided: n => q.undecided.all(n).map(row),
    pendingTeacher: n => q.pending.all(n).map(row),
    decide(id, d) { q.decide.run(id, d.bucket, d.stage, d.p?.urgent ?? null, d.p?.later ?? null, d.p?.ignore ?? null, d.reason ?? null, d.model ?? null, Date.now()); },
    label(id, bucket, source, confidence, reason) { q.label.run(id, bucket, source, confidence ?? null, reason ?? null, Date.now()); },
    get: id => row(q.get.get(id)),
    /** Whether the user wrote anywhere later in this item's thread (the whole thread, not a window of it). */
    answered: e => !!(e.thread_id && db.prepare(`SELECT 1 FROM events o WHERE o.thread_id=? AND o.source=? AND o.direction='outgoing' AND o.source_time>? LIMIT 1`).get(e.thread_id, e.source, e.source_time ?? e.observed_at)),
    /** Messages in the same thread sent after this one, oldest first: what has happened since. */
    threadAfter: (e, n = 12, offset = 0) => e.thread_id && e.source_time ? db.prepare(`SELECT id, author, author_name, direction, kind, source_time, text FROM events
      WHERE thread_id=? AND source=? AND source_time>? ORDER BY source_time LIMIT ? OFFSET ?`).all(e.thread_id, e.source, e.source_time, n, offset) : [],
    /** How many messages followed this one in its thread, and the user's own most recent ones among them (newest first). */
    threadAfterSummary(e, own = 3) {
      if (!e.thread_id || !e.source_time) return { total: 0, yours: [] };
      return { total: db.prepare(`SELECT COUNT(*) n FROM events WHERE thread_id=? AND source=? AND source_time>?`).get(e.thread_id, e.source, e.source_time).n,
        yours: db.prepare(`SELECT id, direction, kind, source_time, text FROM events WHERE thread_id=? AND source=? AND source_time>? AND direction='outgoing' ORDER BY source_time DESC LIMIT ?`).all(e.thread_id, e.source, e.source_time, own) };
    },
    threadContext: (e, n = 6) => e.thread_id ? q.thread.all(e.thread_id, e.source, e.source_time ?? '9999', n).reverse() : [],
    /** Everything kept, whatever was decided about it: found by words, sender, chat, source, bucket and time, newest first.
     *  Every word must appear in the text or the sender's name (any case). `before` (a time) reads on past a full page. */
    search({ words = [], source, bucket, from, chat, threadId, threadSource, since, before, includeOutgoing = false, limit = 20 } = {}) {
      const like = w => '%' + String(w).replace(/[\\%_]/g, c => '\\' + c) + '%', when = 'COALESCE(e.source_time, e.observed_at)';
      const where = ["(d.stage IS NULL OR d.stage!='synthetic')"], args = [];
      for (const w of words.slice(0, 8)) { where.push("(e.text LIKE ? ESCAPE '\\' OR COALESCE(e.author_name, '') LIKE ? ESCAPE '\\')"); args.push(like(w), like(w)); }
      if (source) { where.push('e.source=?'); args.push(String(source)); }
      if (bucket) { where.push('d.bucket=?'); args.push(String(bucket)); }
      if (from) { where.push("(COALESCE(e.author_name, '') LIKE ? ESCAPE '\\' OR COALESCE(e.author, '') LIKE ? ESCAPE '\\')"); args.push(like(from), like(from)); }
      if (chat) { where.push("COALESCE(json_extract(e.metadata, '$.chat'), '') LIKE ? ESCAPE '\\'"); args.push(like(chat)); }
      if (threadId) { where.push('e.thread_id=? AND e.source=?'); args.push(String(threadId), String(threadSource)); }
      if (!includeOutgoing) where.push("e.direction='incoming'");
      if (since) { where.push(`${when}>?`); args.push(new Date(since).toISOString()); }
      if (before) { where.push(`${when}<?`); args.push(new Date(before).toISOString()); }
      return db.prepare(`SELECT e.id, e.source, e.feed, e.thread_id, e.kind, e.metadata, e.author, e.author_name, ${when} AS source_time, e.is_group, e.direction, e.text, e.url,
        d.bucket, d.stage, d.reason, d.decided_at, ${ANSWERED} AS answered
        FROM events e LEFT JOIN decisions d ON d.event_id=e.id WHERE ${where.join(' AND ')} ORDER BY ${when} DESC LIMIT ?`).all(...args, Math.max(1, Math.min(Number(limit) || 20, 100)));
    },
    /** Items in a bucket whose own time (when they were sent, not when they were classified) is after `since`, newest first. */
    queue({ bucket, since = 0, limit = 50, source }) {
      const sinceIso = new Date(Number(since) || 0).toISOString();
      return db.prepare(`SELECT e.id, e.source, e.feed, e.thread_id, e.kind, e.metadata, e.author, e.author_name, COALESCE(e.source_time, e.observed_at) AS source_time, e.is_group, e.text, e.url,
        d.bucket, d.stage, d.reason, d.decided_at, ${ANSWERED} AS answered
        FROM decisions d JOIN events e ON e.id=d.event_id
        WHERE d.bucket=? AND COALESCE(e.source_time, e.observed_at)>? AND e.direction='incoming' AND d.stage!='synthetic' ${source ? 'AND e.source=?' : ''}
        ORDER BY COALESCE(e.source_time, e.observed_at) DESC LIMIT ?`)
        .all(...[String(bucket), sinceIso, ...(source ? [String(source)] : []), Math.max(1, Math.min(Number(limit) || 50, 500))]);
    },
    /** Urgent items decided after `afterDecidedAt` and sent within `maxAgeMs`: what an alerting client still needs to hear about. */
    urgentUpdates({ afterDecidedAt = 0, maxAgeMs = 24 * 3600e3, undeliveredOnly = false, limit = 50 } = {}) {
      // `answered` only says the user wrote in the thread afterwards. That is not the same as resolved ("can't, still need help"),
      // so nothing is held back on it: the receiver gets the flag and the later messages and judges for itself.
      return db.prepare(`SELECT e.id, e.source, e.thread_id, e.kind, e.metadata, e.author, e.author_name, COALESCE(e.source_time, e.observed_at) AS source_time, e.is_group, e.text, e.url, d.stage, d.reason, d.decided_at, ${ANSWERED} AS answered
        FROM decisions d JOIN events e ON e.id=d.event_id
        WHERE d.bucket='urgent' AND d.decided_at>? AND COALESCE(e.source_time, e.observed_at)>? AND e.direction='incoming' AND d.stage!='synthetic'
        ${undeliveredOnly ? 'AND d.delivered_at IS NULL' : ''} ORDER BY d.decided_at ASC LIMIT ?`)
        .all(Number(afterDecidedAt) || 0, new Date(Date.now() - maxAgeMs).toISOString(), Math.max(1, Math.min(Number(limit) || 50, 200)));
    },
    /** Whether another item in the same conversation (the thread, or the sender where there is no thread) raised a heads-up at or after `sinceMs`. */
    recentHeadsUp: (e, sinceMs) => !!db.prepare(`SELECT 1 FROM decisions d JOIN events o ON o.id=d.event_id WHERE d.heads_up_at>=? AND o.source=? AND o.id!=?
      AND ${e.thread_id ? 'o.thread_id=?' : 'o.thread_id IS NULL AND o.author IS ?'} LIMIT 1`).get(sinceMs, e.source, e.id, e.thread_id ?? e.author ?? null),
    /** Mark an item for a heads-up. Times are kept distinct so they can serve as a delivery cursor. */
    raiseHeadsUp(id, reason) {
      const at = Math.max(Date.now(), (db.prepare('SELECT MAX(heads_up_at) m FROM decisions').get().m || 0) + 1);
      db.prepare('UPDATE decisions SET heads_up_at=?, heads_up_reason=? WHERE event_id=?').run(at, String(reason).slice(0, 120), id); return at;
    },
    /** Heads-ups raised after `afterAt` for items sent within `maxAgeMs` that nobody (agent or user) has labelled yet, oldest first. */
    headsUpUpdates({ afterAt = 0, maxAgeMs = 12 * 3600e3, limit = 50 } = {}) {
      return db.prepare(`SELECT e.id, e.source, e.thread_id, e.kind, e.metadata, e.author, e.author_name, COALESCE(e.source_time, e.observed_at) AS source_time, e.is_group, e.text, e.url,
        d.bucket, d.stage, d.reason, d.decided_at, d.heads_up_at, d.heads_up_reason, ${ANSWERED} AS answered
        FROM decisions d JOIN events e ON e.id=d.event_id
        WHERE d.heads_up_at>? AND COALESCE(e.source_time, e.observed_at)>? AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.event_id=e.id AND l.source IN ('agent','user'))
        ORDER BY d.heads_up_at ASC LIMIT ?`)
        .all(Number(afterAt) || 0, new Date(Date.now() - maxAgeMs).toISOString(), Math.max(1, Math.min(Number(limit) || 50, 200)));
    },
    /** What a teaching agent should label next, most useful first:
     *  items waiting for it, then recent items the built-in teacher was unsure about, then a spot-check of the student's own decisions. */
    toLabel({ limit = 20, source } = {}) {
      const n = Math.max(1, Math.min(Number(limit) || 20, 50)); const src = source ? 'AND e.source=?' : ''; const a = source ? [String(source)] : [];
      const t = 'COALESCE(e.source_time, e.observed_at)'; const ago = days => new Date(Date.now() - days * 86400e3).toISOString();
      const judged = `EXISTS (SELECT 1 FROM labels l WHERE l.event_id=e.id AND l.source IN ('agent','user'))`;
      const pick = (why, where, order, extra, k) => k <= 0 ? [] : db.prepare(`SELECT e.*, d.stage, '${why}' AS why FROM decisions d JOIN events e ON e.id=d.event_id
        WHERE ${where} AND e.direction='incoming' ${src} ORDER BY ${order} LIMIT ?`).all(...extra, ...a, k).map(row);
      const waiting = pick('waiting for a label', `d.stage='pending_agent'`, `COALESCE(d.p_urgent,0) DESC, ${t} DESC`, [], n);
      const unsure = pick('teacher was unsure', `d.stage='teacher' AND NOT ${judged} AND ${t}>? AND
        (SELECT l.confidence FROM labels l WHERE l.event_id=e.id AND l.source='teacher' ORDER BY l.id DESC LIMIT 1)='low'`, `${t} DESC`, [ago(14)], n - waiting.length);
      const left = n - waiting.length - unsure.length;   // spot-checks fill a fifth of a busy batch, or all of an otherwise empty one
      const audit = pick('spot-check of the local model', `d.stage='student' AND ${t}>? AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.event_id=e.id)`, 'RANDOM()', [ago(7)],
        waiting.length + unsure.length ? Math.min(left, Math.ceil(n / 5)) : left);
      return [...waiting, ...unsure, ...audit];
    },
    /** Items held for the agent for longer than `olderThanMs`. */
    pendingAgent: (olderThanMs, n) => db.prepare(`SELECT e.* FROM events e JOIN decisions d ON d.event_id=e.id WHERE d.stage='pending_agent' AND d.decided_at<? ORDER BY d.decided_at LIMIT ?`)
      .all(Date.now() - olderThanMs, n).map(row),
    /** The latest agent or user label for recent items of a source, next to what the local model predicted for them. */
    judged: (source, n = 300) => db.prepare(`SELECT l.bucket AS label, d.p_urgent, d.p_later, d.p_ignore FROM labels l JOIN decisions d ON d.event_id=l.event_id JOIN events e ON e.id=l.event_id
      WHERE e.source=? AND l.source IN ('agent','user') AND d.p_later IS NOT NULL
        AND l.id=(SELECT MAX(l2.id) FROM labels l2 WHERE l2.event_id=l.event_id AND l2.source IN ('agent','user')) ORDER BY l.id DESC LIMIT ?`).all(String(source), n),
    /** A connector reported in (with or without new items). Kept per account so one silent account is visible next to a live one. */
    contact(source, account, status) {
      const k = `${String(source).slice(0, 40)}:${String(account ?? '').replace(/[^\w.-]/g, '').slice(0, 40)}`; const set = (a, v) => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(a, String(v));
      set(`contact:${k}`, Date.now());
      if (typeof status === 'string' && status) set(`state:${k}`, status.replace(/[^\w .-]/g, '').slice(0, 40));
    },
    /** Per source: when a connector last reported in, when the last item arrived, how late items arrive, and what is still waiting. */
    health(now = Date.now()) {
      const out = {}; const day = now - 86400e3;
      const sources = new Set([...db.prepare(`SELECT DISTINCT source FROM events`).all().map(r => r.source), ...db.prepare(`SELECT key FROM kv WHERE key LIKE 'contact:%'`).all().map(r => r.key.split(':')[1])]);
      for (const s of sources) {
        if (s === 'test') continue;
        const accounts = {};
        for (const r of db.prepare(`SELECT key, value FROM kv WHERE key LIKE ?`).all(`contact:${s}:%`)) accounts[r.key.split(':').slice(2).join(':') || 'default'] = Number(r.value);
        const lastContact = Math.max(0, ...Object.values(accounts));
        const states = Object.fromEntries(db.prepare(`SELECT key, value FROM kv WHERE key LIKE ?`).all(`state:${s}:%`).map(r => [r.key.split(':').slice(2).join(':') || 'default', r.value]));

        const last = db.prepare(`SELECT MAX(created_at) at, MAX(source_time) sent FROM events WHERE source=? AND COALESCE(feed,'')!='history'`).get(s);
        // Lag: how long after it was sent a live item reached this server.
        const lags = db.prepare(`SELECT (created_at - CAST(strftime('%s', source_time) AS INTEGER) * 1000) / 1000.0 AS lag FROM events
          WHERE source=? AND created_at>? AND COALESCE(feed,'')!='history' AND source_time IS NOT NULL ORDER BY lag`).all(s, day).map(r => r.lag).filter(x => x >= 0);
        const pct = p => lags.length ? Math.round(lags[Math.min(lags.length - 1, Math.floor(p * lags.length))]) : null;
        const waiting = Object.fromEntries(db.prepare(`SELECT d.stage, COUNT(*) n FROM decisions d JOIN events e ON e.id=d.event_id WHERE e.source=? AND d.stage IN ('pending_teacher','pending_agent','teacher_failed') GROUP BY 1`).all(s).map(r => [r.stage, r.n]));
        out[s] = {
          lastContact: lastContact ? new Date(lastContact).toISOString() : null, minutesSinceContact: lastContact ? Math.round((now - lastContact) / 60e3) : null,
          accounts: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, { lastContact: new Date(v).toISOString(), minutesSinceContact: Math.round((now - v) / 60e3), state: states[k] }])),
          lastNewItem: last.at ? new Date(last.at).toISOString() : null, newestItemSentAt: last.sent ?? null,
          itemsLast24h: db.prepare(`SELECT COUNT(*) n FROM events WHERE source=? AND created_at>? AND COALESCE(feed,'')!='history'`).get(s, day).n,
          oldHistoryLast24h: db.prepare(`SELECT COUNT(*) n FROM events WHERE source=? AND created_at>? AND feed='history'`).get(s, day).n,
          // A feed shows posts that may be hours old when they are first seen, so "lag" only means something for messages and mail.
          lagSeconds: s === 'x' ? undefined : { median: pct(0.5), p90: pct(0.9) },
          notYetClassified: db.prepare(`SELECT COUNT(*) n FROM events e LEFT JOIN decisions d ON d.event_id=e.id WHERE e.source=? AND d.event_id IS NULL`).get(s).n,
          waiting,
        };
      }
      return out;
    },
    /** How the alerts and the local model have held up against later judgement (agent or user labels), over the last `days`. */
    quality(days = 30, now = Date.now()) {
      const since = now - days * 86400e3; const out = {};
      const latest = `(SELECT l.bucket FROM labels l WHERE l.event_id=e.id AND l.source IN ('agent','user') ORDER BY l.id DESC LIMIT 1)`;
      for (const { source: s } of db.prepare(`SELECT DISTINCT source FROM events WHERE source!='test'`).all()) {
        const n = (where, ...a) => db.prepare(`SELECT COUNT(*) n FROM decisions d JOIN events e ON e.id=d.event_id WHERE e.source=? AND e.direction='incoming' AND e.created_at>? AND ${where}`).get(s, since, ...a).n;
        // Alerts: items the teacher (or the model) called urgent, then judged by the agent or the user.
        const alertsChecked = n(`EXISTS (SELECT 1 FROM labels l WHERE l.event_id=e.id AND l.source='teacher' AND l.bucket='urgent') AND ${latest} IS NOT NULL`);
        const alertsUpheld = n(`EXISTS (SELECT 1 FROM labels l WHERE l.event_id=e.id AND l.source='teacher' AND l.bucket='urgent') AND ${latest}='urgent'`);
        // Misses: items first filed as later or ignore that the agent or the user then raised to urgent.
        const raised = n(`${latest}='urgent' AND (EXISTS (SELECT 1 FROM labels l WHERE l.event_id=e.id AND l.source='teacher' AND l.bucket!='urgent') OR d.p_later IS NOT NULL AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.event_id=e.id AND l.source='teacher'))`);
        // The local model on its own: decisions it made alone that were later checked.
        const checked = db.prepare(`SELECT l.bucket AS label, d.bucket, d.stage, d.p_urgent, d.p_later, d.p_ignore FROM labels l JOIN decisions d ON d.event_id=l.event_id JOIN events e ON e.id=l.event_id
          WHERE e.source=? AND e.created_at>? AND d.p_later IS NOT NULL AND l.id=(SELECT MAX(l2.id) FROM labels l2 WHERE l2.event_id=l.event_id)`).all(s, since);
        const top = r => ['urgent', 'later', 'ignore'].map(b => [r['p_' + b] ?? 0, b]).sort((a, b) => b[0] - a[0])[0][1];
        const sure = checked.filter(r => { const p = [r.p_urgent ?? 0, r.p_later ?? 0, r.p_ignore ?? 0].sort((a, b) => b - a); return p[0] - p[1] >= 0.8; });
        out[s] = {
          alerts: { checked: alertsChecked, upheld: alertsUpheld, falseAlarms: alertsChecked - alertsUpheld },
          urgentRaisedAfterwards: raised,
          urgentWhereYouWroteAfterwards: n(`d.bucket='urgent' AND d.stage!='synthetic' AND ${ANSWERED}`),
          localModel: { scoredAndLabelled: checked.length, topPickAgrees: checked.filter(r => top(r) === r.label).length,
            confident: sure.length, confidentAndRight: sure.filter(r => top(r) === r.label).length, confidentButUrgent: sure.filter(r => r.label === 'urgent' && top(r) !== 'urgent').length },
        };
      }
      // Heads-ups: how often the agent was woken, why, and what it (or the user) made of those items afterwards.
      const hu = db.prepare(`SELECT d.heads_up_reason AS why, ${latest} AS label FROM decisions d JOIN events e ON e.id=d.event_id WHERE d.heads_up_at>?`).all(since);
      const headsUps = { raised: hu.length, byReason: { rule: hu.filter(h => h.why?.startsWith('rule:')).length, model: hu.filter(h => h.why === 'model').length },
        labelledSince: hu.filter(h => h.label).length, labelledUrgent: hu.filter(h => h.label === 'urgent').length };
      return { days, bySource: out, headsUps };
    },
    markDelivered(ids) { const q = db.prepare('UPDATE decisions SET delivered_at=? WHERE event_id=?'); for (const id of ids) q.run(Date.now(), id); },
    stats() {
      return {
        events: db.prepare(`SELECT source, COUNT(*) n FROM events GROUP BY source`).all(),
        decisions: db.prepare(`SELECT e.source, d.stage, d.bucket, COUNT(*) n FROM decisions d JOIN events e ON e.id=d.event_id GROUP BY 1,2,3`).all(),
        labels: db.prepare(`SELECT source, bucket, COUNT(*) n FROM labels GROUP BY 1,2`).all(),
        undecided: db.prepare(`SELECT COUNT(*) n FROM events e LEFT JOIN decisions d ON d.event_id=e.id WHERE d.event_id IS NULL`).get().n,
      };
    },
    kv: { get: k => db.prepare('SELECT value FROM kv WHERE key=?').get(k)?.value, set: (k, v) => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)) },
  };
}
