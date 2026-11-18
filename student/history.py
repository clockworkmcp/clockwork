"""Label history: how earlier messages from the same sender, and in the same chat, were judged.

For each event, only labels on messages sent before it count, so the trainer sees what the scorer would have known.
Labels come from the teacher, the agent and the user (never synthetic ones, never the student's own decisions, so the
student cannot talk itself into a habit).
"""
import math
import numpy as np
from context import _when

VERSION = 'h1'
BUCKETS = ['urgent', 'later', 'ignore']
RANK = {'user': 4, 'agent': 3, 'teacher': 2, 'import': 1}
NAMES = [f'{scope}_{k}' for scope in ('hist_sender', 'hist_thread') for k in ('n', 'none', 'urgent', 'later', 'ignore')]

class Labels:
    def __init__(self, db):
        best = {}
        for r in db.execute("""SELECT e.id, e.source, e.author, e.thread_id, e.source_time, e.observed_at, l.bucket, l.source AS ls
                               FROM labels l JOIN events e ON e.id = l.event_id
                               WHERE l.source != 'synthetic' AND e.direction = 'incoming' ORDER BY l.created_at"""):
            if r['bucket'] in BUCKETS and (r['id'] not in best or RANK.get(r['ls'], 0) >= RANK.get(best[r['id']]['ls'], 0)): best[r['id']] = r
        self.by = {'sender': {}, 'thread': {}}
        for r in best.values():
            t = _when(r)
            if t is None: continue
            if r['author']: self.by['sender'].setdefault((r['source'], r['author']), []).append((t, r['id'], r['bucket']))
            if r['thread_id']: self.by['thread'].setdefault((r['source'], r['thread_id']), []).append((t, r['id'], r['bucket']))
        for d in self.by.values():
            for v in d.values(): v.sort()

    def prior(self, scope, key, t, own_id):
        """[log count, no-history flag, share urgent, share later, share ignore] over labelled messages before `t`."""
        rows = [b for (x, i, b) in self.by[scope].get(key, ()) if x < t and i != own_id]
        n = len(rows)
        if not n: return [0.0, 1.0, 0.0, 0.0, 0.0]
        return [math.log1p(n), 0.0] + [rows.count(b) / n for b in BUCKETS]

def build(db, events):
    h = Labels(db); out = []
    for e in events:
        t = _when(e); row = []
        for scope, col in (('sender', 'author'), ('thread', 'thread_id')):
            # In a one-to-one chat the thread is the sender, and on X a thread is a single post: the sender block covers both.
            use = t is not None and e.get(col) and not (scope == 'thread' and (e['source'] == 'x' or not e.get('is_group')))
            row += h.prior(scope, (e['source'], e[col]), t, e.get('id')) if use else [0.0, 1.0, 0.0, 0.0, 0.0]
        out.append(row)
    return np.array(out, np.float32).reshape(len(events), len(NAMES))
