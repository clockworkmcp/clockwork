"""The full input the student sees for one event, built the same way by the trainer and the scorer:
  [ embedding of the item text | embedding of the last few thread messages | scaled context features | scaled label history ]
Changing the layout means changing VERSION; the scorer refuses a model trained for another version.
"""
import numpy as np
from common import embed, item_text
import context, history

VERSION = 'f3:' + context.VERSION + ':' + history.VERSION
CTX_SCALE = 0.05                  # context features are standardised, then shrunk so they nudge rather than dominate
HIST_SCALE = 0.05                 # label history: measured 2026-11-13 (experiment.py). More weight decides more alone but keeps more real urgent items
N_CTX = len(context.NAMES)
THREAD_SOURCES = {'whatsapp'}     # sources where earlier messages in the thread are embedded too
STUB = {'thread_id': None, 'author': None, 'metadata': None, 'is_group': 0, 'source_time': None, 'observed_at': None, 'text': ''}

def thread_text(db, e, n=4):
    """The last `n` messages before this one in its thread, as the teacher would read them."""
    if e['source'] not in THREAD_SOURCES or not e.get('thread_id') or not e.get('source_time'): return ''
    rows = db.execute("SELECT direction, text FROM events WHERE thread_id=? AND source=? AND source_time<? AND text!='' ORDER BY source_time DESC LIMIT ?",
                      (e['thread_id'], e['source'], e['source_time'], n)).fetchall()
    return '\n'.join(('me: ' if d == 'outgoing' else 'them: ') + (t or '')[:300] for d, t in reversed(rows))

def raw(db, events, texts=None):
    """Three blocks for `events` (dicts with the events table's columns): text embedding, thread embedding, context features + label history."""
    events = [{**STUB, **e} for e in events]
    X = embed(texts if texts is not None else [item_text(e) for e in events])
    tt = [thread_text(db, e) for e in events]
    T = np.zeros_like(X)
    idx = [i for i, t in enumerate(tt) if t]
    if idx: T[idx] = embed(['earlier in thread:\n' + tt[i] for i in idx])
    return X, T, np.hstack([context.build(db, events), history.build(db, events)])

def assemble(X, T, C, scaler):
    if not len(X): return np.zeros((0, X.shape[1] * 2 + C.shape[1]), np.float32)
    S = scaler.transform(C); S[:, :N_CTX] *= CTX_SCALE; S[:, N_CTX:] *= HIST_SCALE
    return np.hstack([X, T, S])
