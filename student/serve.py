"""Student scorer: POST /score {items:[{id, source, text}]} -> class probabilities from that source's model.
It reads thread history and sender context for each id from the core database (read-only). POST /reload after training."""
import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import joblib
from common import *
import feats

import threading
LOCK = threading.Lock()  # one embedding batch at a time keeps memory flat
state = {'model': None, 'meta': None}
def reload():
    mp, jp = os.path.join(model_dir(), 'meta.json'), os.path.join(model_dir(), 'model.joblib')
    state['model'], state['meta'] = None, None
    if os.path.exists(mp) and os.path.exists(jp):
        meta = json.load(open(mp))
        # A model trained on another encoder or another feature layout would give nonsense: refuse until retrained.
        if meta.get('embedder') == EMBEDDER_ID and meta.get('features') == feats.VERSION: state['model'], state['meta'] = joblib.load(jp), meta
        else: print(f"model was trained for {meta.get('embedder')} / {meta.get('features')}, serving {EMBEDDER_ID} / {feats.VERSION}: waiting for a retrain", flush=True)
    elif os.path.exists(mp): print('no model for the current feature layout yet: waiting for a retrain', flush=True)
    return state['meta']

def score(items):
    """Class probabilities per item id, from that item's source model. Thread history and context come from the database."""
    m, meta = state['model'], state['meta']; db = open_db()
    try:
        ids = [str(i['id']) for i in items]; rows = {}
        for k in range(0, len(ids), 400):
            for r in db.execute(f"SELECT * FROM events WHERE id IN ({','.join('?' * len(ids[k:k + 400]))})", ids[k:k + 400]): rows[r['id']] = dict(r)
        events = [rows.get(str(i['id'])) or {'id': str(i['id']), 'source': i.get('source') or '', 'direction': 'incoming'} for i in items]
        X, T, C = feats.raw(db, events, [i['text'] for i in items])
    finally: db.close()
    Z = feats.assemble(X, T, C, m['scaler']); scores, urgent = {}, {}
    for j, (i, e) in enumerate(zip(items, events)):
        head = m['heads'].get(e['source'])
        if head is None: continue
        p = head.predict_proba(Z[j:j + 1])[0]; cls = list(head.classes_)
        scores[i['id']] = {b: (float(p[cls.index(b)]) if b in cls else 0.0) for b in BUCKETS}
        det = m['urgent'].get(e['source'])
        if det is not None: urgent[i['id']] = float(det.predict_proba(Z[j:j + 1])[0, 1])
    return {'model': meta['version'], 'trainedSources': meta['trainedSources'], 'scores': scores, 'urgentScores': urgent, 'urgentThresholds': meta.get('urgentThresholds') or {}}

# The encoder itself holds about 0.9 GB once it has been used (weights, tokenizer, working buffers), so the limit sits well above
# that: it is there to stop a runaway, not to police normal work.
RSS_LIMIT_MB = int(os.environ.get('CLOCKWORK_STUDENT_MAX_MB', '1300'))
def rss_mb():
    """Memory this process really holds. The model file and libraries are mapped from disk and the system can drop
    those pages whenever it needs room, so they are not counted: counting them made the limit trip on a healthy process."""
    try:
        for line in open('/proc/self/status'):
            if line.startswith('RssAnon:'): return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError): pass
    return 0
import ctypes
try: _libc = ctypes.CDLL('libc.so.6')
except OSError: _libc = None
def release_memory():
    """Hand freed memory back to the system. Embedding texts of many different lengths leaves the C heap fragmented, and
    without this the process keeps growing through a long run of them."""
    if _libc is not None:
        try: _libc.malloc_trim(0)
        except Exception: pass

def guard_memory():
    """Safety net: this process must never crowd out the rest of the instance. Past the limit it exits and the supervisor starts a fresh one."""
    release_memory(); used = rss_mb()
    if used > RSS_LIMIT_MB: print(f'student is using {used} MB (limit {RSS_LIMIT_MB}): restarting', flush=True); os._exit(3)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self.send(200, {'ok': True, 'model': state['meta']}) if self.path == '/health' else self.send(404, {})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)) or b'{}')
        if self.path == '/reload': return self.send(200, {'model': reload()})
        if self.path == '/embed':
            with LOCK: embed(body.get('texts') or [])
            self.send(200, {'ok': True}); return guard_memory()
        if self.path != '/score': return self.send(404, {})
        if state['model'] is None: return self.send(503, {'error': 'no trained model'})
        with LOCK: out = score(body.get('items') or [])
        self.send(200, out); guard_memory()

if __name__ == '__main__':
    reload(); embed(['warm up'])
    port = int(os.environ.get('CLOCKWORK_STUDENT_PORT', '4601')); host = os.environ.get('CLOCKWORK_STUDENT_HOST', '127.0.0.1')
    print(f"student on http://{host}:{port} model={state['meta'] and state['meta']['version']}", flush=True)
    ThreadingHTTPServer((host, port), H).serve_forever()
