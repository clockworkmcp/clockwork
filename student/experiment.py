"""Research harness: compare input layouts for the student on the same grouped folds the trainer uses.

  python experiment.py              frozen encoder: text only / current layout / + label history
  python experiment.py --ft         also fine-tune the encoder on "message + sender + thread" as one input (slow; 5 encoders)

Per source it prints: agreement with the labels, how much the student would decide on its own under the live gate
(top-two margin, urgent floor, urgent detector) and how often those decisions are right, and for the urgent detector
the share of non-urgent items flagged at 90% recall, the precision there, and AUC. Counts only; no message content.
"""
import json, os, sys, time
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score
from common import *
import feats, history, train as T

MARGIN, FLOOR = 0.8, 0.05

def groups_of(items):
    return [r['source'] + ':' + ((r['thread_id'] or r['author'] or '') if r['source'] == 'whatsapp' else (r['text'] or '')[:60] if r['source'] == 'x' else (r['author'] or '')) for r in items]

def evaluate(name, Z, items, y, w, f, synth, out):
    yb = (y == 'urgent').astype(int); src = np.array([r['source'] for r in items]); real = ~synth
    fit_u = lambda Xa, ya, wa: LogisticRegression(C=4.0, max_iter=3000, class_weight='balanced').fit(Xa, ya, sample_weight=wa)
    for s in sorted(set(src)):
        k = src == s; kr = k & real
        if kr.sum() < 200: continue
        P = T.cv_predict(Z[kr], y[kr], w[kr], f[kr], synth[kr], T.fit, lambda m, Xt: [dict(zip(m.classes_, p)) for p in m.predict_proba(Xt)])
        yk = y[kr]; top = np.array([max(p, key=p.get) for p in P]); acc = float((top == yk).mean())
        res = {'labels': int(kr.sum()), 'agreement': round(acc, 4)}
        us = np.full(kr.sum(), np.nan); thr = None
        if yb[kr].sum() >= 5:
            sc = np.array([np.nan if v is None else v for v in T.cv_predict(Z[k], yb[k], w[k], f[k], synth[k], fit_u, lambda m, Xt: m.predict_proba(Xt)[:, 1])], float)
            us = sc[real[k]]; isu = yb[kr] == 1; rep = T.urgent_report(us, isu)
            if rep:
                thr = rep['threshold']; flagged = us >= thr
                res['urgent'] = {'real': int(isu.sum()), 'flaggedNonUrgentAt90': rep['flaggedShareOfNonUrgent'], 'precisionAt90': round(float(isu[flagged].mean()), 3),
                                 'auc': round(float(roc_auc_score(isu, us)), 3), 'recallTop10pct': rep['recallAtTop10pct']}
        kept = np.zeros(kr.sum(), bool)
        for i, p in enumerate(P):
            r = sorted(((p.get(b, 0.0), b) for b in BUCKETS), reverse=True)
            kept[i] = (r[0][0] - r[1][0] >= MARGIN and r[0][1] != 'urgent' and p.get('urgent', 0.0) <= FLOOR and not (thr is not None and us[i] >= thr))
        res['decidesAlone'] = round(float(kept.mean()), 3); res['rightWhenAlone'] = round(float((top[kept] == yk[kept]).mean()), 3) if kept.any() else None
        res['urgentWronglyKept'] = int((kept & (yk == 'urgent')).sum())
        out.setdefault(s, {})[name] = res
        print(f"{s:9s} {name:22s} agree {acc:.3f}  alone {res['decidesAlone']:.3f} right {res['rightWhenAlone']}  urgent-kept {res['urgentWronglyKept']}  urgent {json.dumps(res.get('urgent'))}", flush=True)

def combined_text(db, e):
    """One input for a fine-tuned encoder: the message first (so truncation eats the thread, not the message), then what came before."""
    t = feats.thread_text(db, {**feats.STUB, **e}, n=6)
    return item_text(e) + ('\nearlier in thread:\n' + t if t else '')

def main():
    items = T.load(); db = open_db()
    y = np.array([r['label'] for r in items]); synth = np.array([r['label_source'] == 'synthetic' for r in items]); real = ~synth
    w = np.array([(3.0 if r['label_source'] == 'user' else 1.5 if r['label_source'] == 'agent' else 1.0) * (0.5 if r['confidence'] == 'low' else 1.0) for r in items])
    f = T.folds(groups_of(items)); out = {}
    X, Th, CH = feats.raw(db, items); C, H = CH[:, :feats.N_CTX], CH[:, feats.N_CTX:]
    sc = StandardScaler().fit(C[real]); sh = StandardScaler().fit(H[real])
    Cs = sc.transform(C) * feats.CTX_SCALE
    evaluate('text only', X, items, y, w, f, synth, out)
    evaluate('current (f2:ctx1)', np.hstack([X, Th, Cs]), items, y, w, f, synth, out)
    for scale in (0.05, 0.15, 0.4):
        evaluate(f'+history x{scale}', np.hstack([X, Th, Cs, sh.transform(H) * scale]), items, y, w, f, synth, out)
    if '--ft' in sys.argv:
        import torch, finetune as FT
        texts = [combined_text(db, r) for r in items]
        y3 = np.array([BUCKETS.index(b) for b in y]); yu = (y == 'urgent').astype(np.int64); use3 = real.astype(np.float32); wf = w.astype(np.float32)
        Xf = np.zeros((len(items), 384), np.float32); t0 = time.time()
        for i in range(5):
            tr = np.where((f != i) | synth)[0]; te = (f == i) & real
            m = FT.finetune([texts[j] for j in tr], y3[tr], yu[tr], wf[tr], use3[tr], seed=i)
            Xf[te] = FT.embed_with(m, [texts[j] for j in np.where(te)[0]])
            # Training rows get embeddings from an encoder that saw them; the head is refit per fold below on those, as it would be in production.
            np.save(os.path.join(model_dir(), f'exp-ft-fold{i}.npy'), FT.embed_with(m, texts)); del m
            if FT.DEV == 'mps': torch.mps.empty_cache()
            print(f'fine-tune fold {i + 1}/5 done ({time.time() - t0:.0f}s)', flush=True)
        for name, extra in (('fine-tuned', None), ('fine-tuned +ctx', Cs), ('fine-tuned +ctx +hist', np.hstack([Cs, sh.transform(H) * 0.15]))):
            evaluate_ft(name, extra, items, y, w, f, synth, out)
    json.dump(out, open(os.path.join(model_dir(), 'experiment.json'), 'w'), indent=1)

def evaluate_ft(name, extra, items, y, w, f, synth, out):
    """Like evaluate(), but each fold uses the embeddings from the encoder that never saw that fold."""
    real = ~synth; Z = []
    for i in range(5):
        E = np.load(os.path.join(model_dir(), f'exp-ft-fold{i}.npy')); Z.append(E if extra is None else np.hstack([E, extra]))
    src = np.array([r['source'] for r in items]); yb = (y == 'urgent').astype(int)
    fit_u = lambda Xa, ya, wa: LogisticRegression(C=4.0, max_iter=3000, class_weight='balanced').fit(Xa, ya, sample_weight=wa)
    for s in sorted(set(src)):
        k = src == s; kr = k & real
        if kr.sum() < 200: continue
        P = {}; U = {}
        for i in range(5):
            te = np.where(kr & (f == i))[0]
            if not len(te): continue
            tr3 = kr & (f != i); m3 = T.fit(Z[i][tr3], y[tr3], w[tr3])
            for j, p in zip(te, m3.predict_proba(Z[i][te])): P[j] = dict(zip(m3.classes_, p))
            tru = k & ((f != i) | synth)
            if yb[tru].sum() >= 5:
                mu = fit_u(Z[i][tru], yb[tru], w[tru])
                for j, v in zip(te, mu.predict_proba(Z[i][te])[:, 1]): U[j] = v
        idx = np.where(kr)[0]; yk = y[idx]; top = np.array([max(P[j], key=P[j].get) for j in idx]); acc = float((top == yk).mean())
        res = {'labels': int(len(idx)), 'agreement': round(acc, 4)}; thr = None; us = np.array([U.get(j, np.nan) for j in idx])
        if U:
            isu = yk == 'urgent'; rep = T.urgent_report(us, isu)
            if rep:
                thr = rep['threshold']; flagged = us >= thr
                res['urgent'] = {'real': int(isu.sum()), 'flaggedNonUrgentAt90': rep['flaggedShareOfNonUrgent'], 'precisionAt90': round(float(isu[flagged].mean()), 3),
                                 'auc': round(float(roc_auc_score(isu, us)), 3), 'recallTop10pct': rep['recallAtTop10pct']}
        kept = np.zeros(len(idx), bool)
        for n, j in enumerate(idx):
            p = P[j]; r = sorted(((p.get(b, 0.0), b) for b in BUCKETS), reverse=True)
            kept[n] = (r[0][0] - r[1][0] >= MARGIN and r[0][1] != 'urgent' and p.get('urgent', 0.0) <= FLOOR and not (thr is not None and us[n] >= thr))
        res['decidesAlone'] = round(float(kept.mean()), 3); res['rightWhenAlone'] = round(float((top[kept] == yk[kept]).mean()), 3) if kept.any() else None
        res['urgentWronglyKept'] = int((kept & (yk == 'urgent')).sum())
        out.setdefault(s, {})[name] = res
        print(f"{s:9s} {name:22s} agree {acc:.3f}  alone {res['decidesAlone']:.3f} right {res['rightWhenAlone']}  urgent-kept {res['urgentWronglyKept']}  urgent {json.dumps(res.get('urgent'))}", flush=True)

if __name__ == '__main__': main()
