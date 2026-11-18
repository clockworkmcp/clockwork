"""Fine-tune the student's encoder on this user's labels, then keep using it exactly like the stock one:
the nightly trainer still fits its small heads on (now better) embeddings.

  python finetune.py --cv      out-of-fold comparison against the serving setup (slow; trains 5 encoders)
  python finetune.py --final   train on everything and save to <data>/student/encoder-e5-ft

Measured 2026-11-11 (2,961 real labels + 540 synthetic, 5 grouped folds, 3 epochs): not worth deploying yet.
  accuracy   frozen 77.8% -> fine-tuned 78.5%   (x 86.0 -> 87.6, gmail 73.0 -> 73.5, whatsapp 55.7 -> 50.8 on 185 labels)
  urgent     share of non-urgent items flagged at 90% recall: 27.1% -> 32.6% (worse);
             urgent items ranked in the top 10%: 60.8% -> 70.3% (better)
Re-run --cv after the label set has grown substantially before training a final encoder.
"""
import json, os, sys, time, collections
import numpy as np, torch
from sklearn.linear_model import LogisticRegression
from common import *
import train as T

BASE = 'intfloat/multilingual-e5-small'
EPOCHS = int(os.environ.get('FT_EPOCHS', '3')); MAXLEN = int(os.environ.get('FT_MAXLEN', '256')); BATCH = 16
DEV = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'

def encode(model, texts, grad=False):
    f = model.tokenize(['query: ' + t for t in texts]); f = {k: (v.to(DEV) if hasattr(v, 'to') else v) for k, v in f.items()}
    return torch.nn.functional.normalize(model(f)['sentence_embedding'], dim=-1)

def finetune(texts, y3, yu, w, use3, seed=0):
    """Two objectives on one encoder: the three-way bucket (real items only) and urgent yes/no (real + synthetic)."""
    from sentence_transformers import SentenceTransformer
    torch.manual_seed(seed); rng = np.random.RandomState(seed)
    model = SentenceTransformer(BASE, device=DEV); model.max_seq_length = MAXLEN
    h3 = torch.nn.Linear(384, 3).to(DEV); hu = torch.nn.Linear(384, 1).to(DEV)
    opt = torch.optim.AdamW([{'params': model.parameters(), 'lr': 2e-5}, {'params': list(h3.parameters()) + list(hu.parameters()), 'lr': 1e-3}], weight_decay=0.01)
    pos = float(max(1.0, min(20.0, (len(yu) - yu.sum()) / max(1, yu.sum()))))
    idx = np.arange(len(texts)); steps = EPOCHS * int(np.ceil(len(idx) / BATCH)); step = 0
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / (0.1 * steps)) * max(0.0, 1 - s / steps))
    model.train()
    for ep in range(EPOCHS):
        rng.shuffle(idx)
        for i in range(0, len(idx), BATCH):
            b = idx[i:i + BATCH]; e = encode(model, [texts[j] for j in b]) * 10
            wb = torch.tensor(w[b], dtype=torch.float32, device=DEV); m3 = torch.tensor(use3[b], dtype=torch.float32, device=DEV)
            l3 = (torch.nn.functional.cross_entropy(h3(e), torch.tensor(y3[b], device=DEV), reduction='none') * wb * m3).sum() / m3.sum().clamp(min=1)
            lu = (torch.nn.functional.binary_cross_entropy_with_logits(hu(e).squeeze(-1), torch.tensor(yu[b], dtype=torch.float32, device=DEV),
                  pos_weight=torch.tensor(pos, device=DEV), reduction='none') * wb).mean()
            (l3 + lu).backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); sched.step(); opt.zero_grad(); step += 1
    model.eval(); return model

def embed_with(model, texts):
    out = []
    with torch.no_grad():
        for i in range(0, len(texts), 32): out.append(encode(model, texts[i:i + 32]).cpu().numpy())
    return np.concatenate(out).astype(np.float32)

def prepare():
    items = T.load(); texts = [item_text(r) for r in items]
    y = np.array([r['label'] for r in items]); synth = np.array([r['label_source'] == 'synthetic' for r in items])
    w = np.array([3.0 if r['label_source'] == 'user' else 1.5 if r['label_source'] == 'agent' else (0.5 if r['confidence'] == 'low' else 1.0) for r in items], np.float32)
    groups = [(r['source'] + ':' + (r['author'] or '')) if r['source'] != 'x' else 'x:' + (r['text'] or '')[:60] for r in items]
    return items, texts, y, synth, w, T.folds(groups)

def heads_eval(Xtr, ytr, wtr, synth_tr, Xte):
    """Same heads as the nightly trainer: three-way on real items, urgent on real + synthetic."""
    real = ~synth_tr
    p3 = LogisticRegression(C=4.0, max_iter=3000).fit(Xtr[real], ytr[real], sample_weight=wtr[real]).predict(Xte)
    su = LogisticRegression(C=4.0, max_iter=3000, class_weight='balanced').fit(Xtr, (ytr == 'urgent').astype(int), sample_weight=wtr).predict_proba(Xte)[:, 1]
    return p3, su

def summarize(items, y, synth, pred, score):
    real = ~synth; ok = (pred == y) & real; out = {'bySource': {}}
    for s in sorted({r['source'] for r in items}):
        k = np.array([r['source'] == s for r in items]) & real; out['bySource'][s] = {'labels': int(k.sum()), 'accuracy': round(float(ok[k].mean()), 4)}
    out['accuracy'] = round(float(ok[real].mean()), 4)
    out['urgent'] = {str(t): T.urgent_report(score[real], y[real] == 'urgent', t) for t in (0.9, 0.95)}
    return out

def main():
    items, texts, y, synth, w, f = prepare()
    y3 = np.array([BUCKETS.index(b) for b in y]); yu = (y == 'urgent').astype(np.int64); use3 = (~synth).astype(np.float32)
    if '--smoke' in sys.argv:
        k = np.random.RandomState(0).choice(len(y), 96, replace=False); m = finetune([texts[i] for i in k], y3[k], yu[k], w[k], use3[k])
        print('smoke ok', embed_with(m, texts[:4]).shape, 'device', DEV); return
    if '--cv' in sys.argv:
        res = {}
        for name in ('frozen', 'finetuned'):
            pred = np.empty(len(y), object); score = np.zeros(len(y)); t0 = time.time()
            Xf = embed(texts) if name == 'frozen' else None
            for i in range(5):
                tr = (f != i) | synth; te = (f == i) & ~synth
                if name == 'frozen': Xtr, Xte = Xf[tr], Xf[te]
                else:
                    ti = np.where(tr)[0]; m = finetune([texts[j] for j in ti], y3[ti], yu[ti], w[ti], use3[ti], seed=i)
                    X = embed_with(m, texts); Xtr, Xte = X[tr], X[te]; del m
                    if DEV == 'mps': torch.mps.empty_cache()
                pred[te], score[te] = heads_eval(Xtr, y[tr], w[tr], synth[tr], Xte)
                print(f'{name} fold {i + 1}/5 done ({time.time() - t0:.0f}s)', flush=True)
            res[name] = summarize(items, y, synth, pred, score)
        print(json.dumps(res)); return
    if '--final' in sys.argv:
        m = finetune(texts, y3, yu, w, use3); out = os.path.join(model_dir(), 'encoder-e5-ft'); m.max_seq_length = 512; m.save(out)
        json.dump({'base': BASE, 'trainedAt': time.strftime('%Y-%m-%dT%H:%M:%S'), 'labels': int((~synth).sum()), 'synthetic': int(synth.sum()), 'epochs': EPOCHS, 'maxLen': MAXLEN},
                  open(os.path.join(out, 'clockwork-finetune.json'), 'w'))
        print(json.dumps({'saved': out})); return
    print(__doc__)

if __name__ == '__main__': main()
