"""Shared by the trainer and the scorer. item_text must stay identical to core/features.mjs."""
import json, os, sqlite3, hashlib
import numpy as np

BUCKETS = ['urgent', 'later', 'ignore']
MEDIA = {'image', 'video', 'audio', 'document'}
EMPTY_OTHER = {'senderKeyDistributionMessage', 'messageHistoryNotice', 'messageHistoryBundle', 'placeholderMessage', 'secretEncryptedMessage', 'pollUpdateMessage', 'albumMessage'}

def unseen_kind(e):
    k = e.get('kind') or ''
    if k in MEDIA: return k
    return k[6:] if k.startswith('other:') and k[6:] not in EMPTY_OTHER else None
MIN_LABELS_PER_SOURCE = int(os.environ.get('CLOCKWORK_MIN_LABELS', '200'))

def data_dir():
    d = os.environ.get('CLOCKWORK_DATA') or os.path.join(os.path.expanduser('~'), '.clockwork', 'v2')
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d

def model_dir():
    d = os.path.join(data_dir(), 'student'); os.makedirs(d, mode=0o700, exist_ok=True); return d

def _resolve_embedder():
    """Which encoder to load, and an id for it. A fine-tuned encoder in the data directory wins over the stock one.
    The id goes into cache keys and model metadata, so heads are never paired with embeddings from another encoder."""
    env = os.environ.get('CLOCKWORK_EMBEDDER')
    if env: return env, env
    ft = os.path.join(model_dir(), 'encoder-e5-ft'); info = os.path.join(ft, 'clockwork-finetune.json')
    if os.path.exists(info): return ft, 'e5-ft@' + json.load(open(info))['trainedAt']
    return 'intfloat/multilingual-e5-small', 'intfloat/multilingual-e5-small'

EMBEDDER, EMBEDDER_ID = _resolve_embedder()

def item_text(e):
    where = ('whatsapp group' if e['is_group'] else 'whatsapp direct') if e['source'] == 'whatsapp' else e['source']
    who = ' '.join(' '.join(x for x in (e.get('author_name'), e.get('author')) if x).split())[:120]
    meta = json.loads(e['metadata']) if e.get('metadata') else {}
    quoted = (meta.get('quoted') or {}).get('text')
    q = f" | quoted: {str(quoted)[:300]}" if quoted else ''
    chat = f" | chat: {' '.join(str(meta['chat']).split())[:80]}" if meta.get('chat') else ''
    u = unseen_kind(e); media = f"[{u}, not shown] " if u else ''
    return f"feed: {where}{chat} | from: {who} | {e['direction']}\n{media}{(e.get('text') or '')[:1500]}{q}"

_model = None
def embed(texts):
    """e5 models expect a 'query: ' prefix. Embeddings are cached on disk by text hash."""
    global _model
    cache = os.path.join(model_dir(), 'emb-cache'); os.makedirs(cache, exist_ok=True)
    out = [None] * len(texts); todo = []
    for i, t in enumerate(texts):
        p = os.path.join(cache, hashlib.sha256((EMBEDDER_ID + '\0' + t).encode()).hexdigest()[:24] + '.npy')
        if os.path.exists(p): out[i] = np.load(p)
        else: todo.append((i, p))
    via = os.environ.get('CLOCKWORK_EMBED_VIA')
    if todo and via:
        # Ask the running scorer to embed, so the trainer never loads a second copy of the model into memory.
        # The scorer writes each vector to the shared disk cache; read them back from there.
        import urllib.request
        for k in range(0, len(todo), 32):
            body = json.dumps({'texts': [texts[i] for i, _ in todo[k:k + 32]]}).encode()
            for attempt in range(8):  # the scorer may be restarting: wait for it rather than lose the whole training run
                try: urllib.request.urlopen(urllib.request.Request(via + '/embed', data=body, headers={'content-type': 'application/json'}, method='POST'), timeout=600).read(); break
                except OSError:
                    if attempt == 7: raise
                    import time; time.sleep(20)
        for i, p in todo: out[i] = np.load(p)
        todo = []
    if todo:
        if _model is None:
            from sentence_transformers import SentenceTransformer
            _model = SentenceTransformer(EMBEDDER, device='cpu'); _model.max_seq_length = 512
        prefix = 'query: ' if 'e5' in EMBEDDER_ID else ''
        X = _model.encode([prefix + texts[i] for i, _ in todo], batch_size=int(os.environ.get('CLOCKWORK_EMBED_BATCH', '4')), normalize_embeddings=True, show_progress_bar=False)  # small batches: attention memory grows with batch x length squared
        for (i, p), v in zip(todo, X):
            v = np.asarray(v, np.float32); np.save(p, v); out[i] = v
    return np.stack(out) if out else np.zeros((0, 384), np.float32)

def open_db():
    db = sqlite3.connect(f"file:{os.path.join(data_dir(), 'clockwork.db')}?mode=ro", uri=True); db.row_factory = sqlite3.Row
    return db
