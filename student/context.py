"""Context features for the urgent detector: what one message's text cannot show.

Three groups, all computed as of the moment the message was sent, from events only (never from labels or decisions):
  - sender history: how often this sender writes, whether the user has ever written back, bursts
  - thread state: whether the user is part of the conversation, how recently they spoke
  - deadline cues: words and patterns in the text that state a time limit or ask for action
plus the mail provider's own categories for Gmail.

First measured 2026-11-12, before there was reply history, on 2,961 real labels
(74 urgent; 4 grouped 5-fold splits; second stage over the embedding score plus these features, real items only):
  - Gmail ranking quality unchanged: AUC 0.81 -> 0.82, urgent caught in the top 30% 82% -> 81%.
  - Overall share of non-urgent items flagged at 90% recall unchanged: 27%.
  - Sender-history and thread features made it worse (only 108 sent mails to learn reply behaviour from).
  - Deadline features alone moved the hardest few Gmail urgent items up (flagged share inside Gmail 68% -> 45%),
    but that rests on about six messages and did not show in any steadier measure.
Also measured: the urgent gate is not what keeps the student from deciding Gmail on its own. The 0.8 margin gate
alone lets it keep 14% of Gmail (37% of X); the three-way head is the limit, not this detector.
Re-tested 2026-11-12 after adding 1,984 WhatsApp labels from a fuller account (186 urgent, 3,848 own messages),
3 grouped 5-fold splits, one head per source:
  - WhatsApp agreement with the teacher: 65.1% shared text-only head -> 67.6% per-source -> 70.7% with these features
    plus an embedding of the last four thread messages. WhatsApp urgent AUC 0.79 -> 0.83.
  - Per-source heads alone restore X from 83% to 85% (a shared head is pulled around by the other sources).
  - Student keeps 15% of WhatsApp at margin 0.8 (was 8%), 95% right on what it keeps.
  - Where the teacher was confident the student agrees 85-93%; where the teacher marked low confidence, 57-66%.
So the features help once there is reply history. Wired in through feats.py from that date. `build(db, events)` is the entry point.
"""
import json, math, re
import numpy as np
import deadlines

VERSION = 'ctx1'

# Urgency words beyond English. Whole words where words are separated by spaces; Hebrew and Arabic attach prefixes.
_NOW = (r"(?<!\w)(?:urgente(?:mente)?|urgence|de inmediato|inmediatamente|ahora mismo|tout de suite|imm[ée]diatement|dringend|sofort|eilt"
        r"|agora mesmo|imediatamente|subito|immediatamente|срочно|немедленно|прямо сейчас)(?!\w)|דחוף|עכשיו|מיד\b|عاجل|الآن|الان|فورا|فوراً|حالا")
_CURRENCY = 'usd|eur|gbp|chf|cad|aud|nzd|jpy|cny|inr|brl|mxn|ars|rub|uah|pln|sek|nok|dkk|try|ils|nis|aed|sar|egp|zar|krw|sgd|hkd'
_CUES = {
    'cue_now': r"\b(asap|urgent(ly)?|immediately|right now|right away|emergency|time[- ]sensitive)\b|" + _NOW,
    'cue_today': r"\b(today|tonight|this (morning|afternoon|evening)|in (an?|\d+) (min(ute)?s?|hours?)|within (the )?(next )?(\d+ )?(min(ute)?s?|hours?))\b|" + deadlines.TODAY,
    'cue_tomorrow': r"\b(tomorrow|tmrw|first thing)\b|" + deadlines.TOMORROW,
    'cue_clock': r"\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b([01]?\d|2[0-3]):[0-5]\d\b",
    'cue_date': r"\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b|\b\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b",
    'cue_deadline': r"\b(deadline|due|by (eod|cob|end of (day|week))|no later than|last (chance|day)|final (notice|reminder)|expir(es|ing|y)|overdue|before (it|we|you|the))\b",
    'cue_ask': r"\b(please|pls|can you|could you|would you|need you|let me know|confirm|approve|sign|reply|respond|call me|get back|are you (free|around|there|available))\b",
    'cue_security': r"\b(verification|verify|security alert|sign[- ]in|log[- ]?in|password|one[- ]time|otp|suspicious|unauthori[sz]ed|fraud|code is)\b",
    'cue_money': r"[$€£¥₹₽₩₺₴₪]\s?\d|\b\d+([.,]\d+)?\s?[$€£¥₹₽₩₺₴₪]|\b\d+([.,]\d+)?\s?(" + _CURRENCY + r")\b|\b(invoice|payment (failed|declined|due)|charge(d)?|refund|wire|transfer)\b",
    'cue_plans': r"\b(meet(ing)?|call|zoom|flight|booking|reservation|appointment|pickup|pick up|arriv(e|ing)|on my way|running late|waiting)\b",
    'cue_you': r"\b(you|your|u)\b|\?",
}
_CUES = {k: re.compile(v, re.I) for k, v in _CUES.items()}
_GMAIL_LABELS = ['CATEGORY_PERSONAL', 'CATEGORY_UPDATES', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'IMPORTANT']

NAMES = (['src_gmail', 'src_whatsapp', 'src_x', 'is_group', 'len', 'questions', 'exclaims', 'caps'] + list(_CUES) + ['cue_soon'] +
         ['sender_seen', 'sender_new', 'sender_replied_to', 'sender_reply_ratio', 'sender_burst_1h', 'sender_last_gap',
          'thread_prior', 'thread_mine', 'thread_mine_last', 'thread_mine_gap', 'thread_people'] +
         ['gm_meta'] + ['gm_' + l.lower() for l in _GMAIL_LABELS] + ['gm_bulk', 'gm_attach', 'gm_direct', 'gm_recipients', 'gm_reply'] + deadlines.NAMES)

def _ts(s):
    """ISO time to epoch seconds; None when missing or unreadable."""
    if not s: return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(s).replace('Z', '+00:00')).timestamp()
    except ValueError: return None

def _when(r): return _ts(r['source_time']) or _ts(r['observed_at'])
def _meta(r):
    try: return json.loads(r['metadata']) if r['metadata'] else {}
    except (ValueError, TypeError): return {}
def _addr(s): return (re.search(r'[\w.+-]+@[\w.-]+', s or '') or [''])[0].lower() if s else ''
def _log(n): return math.log1p(max(0.0, float(n)))
def _hours(sec): return min(_log(sec / 3600.0), _log(24 * 90)) if sec is not None else _log(24 * 90)

class History:
    """Looks up what was known about a sender and a thread before a given moment. Queries are indexed and cached per call."""
    def __init__(self, db):
        self.db = db; self._by_author = {}; self._by_thread = {}
        sent = db.execute("SELECT author, metadata, source_time, observed_at FROM events WHERE source='gmail' AND direction='outgoing'").fetchall()
        self.me = {}
        for r in sent: a = _addr(r['author']); self.me[a] = self.me.get(a, 0) + 1
        # When the user last wrote to each address, for "has the user ever written to this sender".
        self.mail_to = {}
        for r in sent:
            t = _when(r)
            for a in set(re.findall(r'[\w.+-]+@[\w.-]+', (_meta(r).get('to') or '').lower())): self.mail_to.setdefault(a, []).append(t or 0)
    def author(self, source, author):
        k = (source, author)
        if k not in self._by_author:
            rows = self.db.execute("SELECT thread_id, direction, source_time, observed_at FROM events WHERE source=? AND author=? AND direction='incoming'", k).fetchall()
            self._by_author[k] = sorted(t for t in (_when(r) for r in rows) if t)
        return self._by_author[k]
    def thread(self, source, thread_id):
        k = (source, thread_id)
        if k not in self._by_thread:
            rows = self.db.execute("SELECT author, direction, source_time, observed_at FROM events WHERE thread_id=? AND source=?", (thread_id, source)).fetchall()
            self._by_thread[k] = sorted(((_when(r) or 0), r['direction'] == 'outgoing', r['author'] or '') for r in rows)
        return self._by_thread[k]

def features(h, e):
    """One feature vector for event row `e` (a dict with the events table's columns)."""
    f = dict.fromkeys(NAMES, 0.0)
    src, text, t = e['source'], e.get('text') or '', _when(e)
    meta = _meta(e); subject = meta.get('subject') or ''
    full = (subject + '\n' + text)[:3000]
    f['src_' + src] = 1.0 if 'src_' + src in f else 0.0
    f['is_group'] = float(bool(e.get('is_group')))
    f['len'] = _log(len(text)); f['questions'] = min(full.count('?'), 5); f['exclaims'] = min(full.count('!'), 5)
    letters = [c for c in full if c.isalpha()]; f['caps'] = sum(c.isupper() for c in letters) / len(letters) if len(letters) >= 20 else 0.0
    for k, rx in _CUES.items(): f[k] = float(bool(rx.search(full)))
    f['cue_soon'] = float(bool(f['cue_now'] or f['cue_today'] or (f['cue_deadline'] and (f['cue_clock'] or f['cue_tomorrow']))))

    if t is not None and e.get('author') and src != 'x':
        prior = [x for x in h.author(src, e['author']) if x < t]
        f['sender_seen'] = _log(len(prior)); f['sender_new'] = float(not prior)
        f['sender_burst_1h'] = _log(sum(1 for x in prior if x > t - 3600))
        f['sender_last_gap'] = _hours(t - prior[-1] if prior else None)
        if src == 'gmail': wrote = sum(1 for x in h.mail_to.get(_addr(e['author']), []) if x < t)
        else: wrote = sum(1 for x, mine, _ in h.thread(src, e['thread_id']) if mine and x < t) if e.get('thread_id') and not e.get('is_group') else 0
        f['sender_replied_to'] = float(wrote > 0); f['sender_reply_ratio'] = min(1.0, wrote / (len(prior) + 1.0))
    else: f['sender_last_gap'] = _hours(None)

    f['thread_mine_gap'] = _hours(None)
    if t is not None and e.get('thread_id') and src != 'x':
        before = [x for x in h.thread(src, e['thread_id']) if x[0] < t]
        mine = [x[0] for x in before if x[1]]
        f['thread_prior'] = _log(len(before)); f['thread_mine'] = float(bool(mine))
        f['thread_mine_last'] = float(bool(before) and before[-1][1]); f['thread_mine_gap'] = _hours(t - mine[-1] if mine else None)
        f['thread_people'] = _log(len({x[2] for x in before if not x[1]}))

    if src == 'gmail' and 'labels' in meta:
        labels = set(meta.get('labels') or []); to = (meta.get('to') or '').lower()
        f['gm_meta'] = 1.0
        for l in _GMAIL_LABELS: f['gm_' + l.lower()] = float(l in labels)
        f['gm_bulk'] = float(bool(meta.get('bulk'))); f['gm_attach'] = float(bool(meta.get('attachments')))
        f['gm_direct'] = float(any(a in to for a in h.me)) if h.me else 0.0
        f['gm_recipients'] = _log(to.count('@')); f['gm_reply'] = float(bool(re.match(r'\s*(re|aw|sv)\s*:', subject, re.I)))
    f.update(zip(deadlines.NAMES, deadlines.features(full, t)))
    return [f[k] for k in NAMES]

def build(db, events):
    """Feature matrix for `events` (dicts with the events table's columns), in order."""
    h = History(db)
    return np.array([features(h, e) for e in events], np.float32).reshape(len(events), len(NAMES))
