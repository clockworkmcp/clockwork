"""Retrain the student (one model per source) from labels in the core database, and promote it only if no source regresses.

Label precedence per event: user > agent > teacher > imported. The newest label of the strongest source wins.
"""
import json, os, sys, time, collections
import numpy as np, joblib
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from common import *
import feats

RANK = {'user': 4, 'agent': 3, 'teacher': 2, 'synthetic': 2, 'import': 1}

def load():
    db = open_db()
    rows = db.execute("""SELECT e.*, l.bucket AS label, l.source AS label_source, l.confidence, l.created_at AS labelled_at
                         FROM labels l JOIN events e ON e.id = l.event_id WHERE e.direction='incoming' ORDER BY l.created_at""").fetchall()
    best = {}
    for r in rows:
        r = dict(r); k = r['id']
        if r['label'] not in BUCKETS: continue
        if k not in best or RANK.get(r['label_source'], 0) >= RANK.get(best[k]['label_source'], 0): best[k] = r
    return list(best.values())

def folds(groups, k=5, seed=0):
    ug = sorted(set(groups)); np.random.RandomState(seed).shuffle(ug); m = {g: i % k for i, g in enumerate(ug)}
    return np.array([m[g] for g in groups])

def served_accuracy_of(meta):
    """Accuracy over the sources a model serves; derived from per-source numbers for models saved before the field existed."""
    if 'servedAccuracy' in meta: return meta['servedAccuracy']
    rows = [meta['bySource'][s] for s in meta.get('trainedSources', []) if s in meta.get('bySource', {})]
    n = sum(r['labels'] for r in rows)
    return sum(r['accuracy'] * r['labels'] for r in rows) / n if n else 0.0

def regressions(prev, by_source, trained_sources, tolerance=0.02):
    """Per-source comparison with the serving model. The label mix changes between retrains, so an overall
    number is not comparable; each source the student serves must hold its own accuracy."""
    out = []
    for s in trained_sources:
        before = (prev.get('bySource') or {}).get(s, {}).get('accuracy')
        if before is not None and s in (prev.get('trainedSources') or []) and by_source[s]['accuracy'] < before - tolerance:
            out.append(f"{s} accuracy {by_source[s]['accuracy']:.3f} below serving model {before:.3f}")
    return out

def fit(X, y, w): return LogisticRegression(C=4.0, max_iter=3000).fit(X, y, sample_weight=w)

def cv_predict(X, y, w, f, synth, fit_fn, score_fn):
    """Out-of-fold predictions for real items. Synthetic items are only ever trained on, never scored."""
    out = [None] * len(y)
    for i in range(5):
        te = (f == i) & ~synth; tr = (f != i) | synth
        if te.sum() == 0: continue
        if len(set(y[tr])) < 2:
            for j in np.where(te)[0]: out[j] = None
            continue
        m = fit_fn(X[tr], y[tr], w[tr])
        for j, v in zip(np.where(te)[0], score_fn(m, X[te])): out[j] = v
    return out

def urgent_report(scores, is_urgent, target_recall=0.9):
    """Pick the highest threshold that still catches `target_recall` of real urgent items; report what it costs."""
    pos = np.sort(scores[is_urgent])
    if len(pos) < 5: return None
    thr = float(pos[int(np.floor((1 - target_recall) * len(pos)))])
    flagged = scores >= thr
    # precision: of the items the detector flags (and so sends to the teacher), the share that really are urgent.
    return {'threshold': round(thr, 4), 'realUrgent': int(is_urgent.sum()), 'recall': round(float(flagged[is_urgent].mean()), 3),
            'precision': round(float(is_urgent[flagged].mean()), 3), 'missedUrgent': int((~flagged[is_urgent]).sum()),
            'flaggedShareOfNonUrgent': round(float(flagged[~is_urgent].mean()), 3),
            'recallAtTop10pct': round(float((scores[is_urgent] >= np.quantile(scores, 0.9)).mean()), 3)}

def main():
    items = load(); db = open_db()
    synth = np.array([r['label_source'] == 'synthetic' for r in items], dtype=bool); real = ~synth
    if real.sum() < 50: print(json.dumps({'trained': False, 'reason': f'only {int(real.sum())} real labels'})); return 0
    y = np.array([r['label'] for r in items]); yb = (y == 'urgent').astype(int); src = np.array([r['source'] for r in items])
    X, T, C = feats.raw(db, items); scaler = StandardScaler().fit(C[real]); Z = feats.assemble(X, T, C, scaler)
    # Human corrections count most, then agent corrections; unsure labels count less.
    w = np.array([(3.0 if r['label_source'] == 'user' else 1.5 if r['label_source'] == 'agent' else 1.0) * (0.5 if r['confidence'] == 'low' else 1.0) for r in items])
    # Keep one chat (messages), one sender (mail) or one post text (feeds) in a single fold so the score is not inflated.
    groups = [r['source'] + ':' + ((r['thread_id'] or r['author'] or '') if r['source'] == 'whatsapp' else (r['text'] or '')[:60] if r['source'] == 'x' else (r['author'] or '')) for r in items]
    f = folds(groups)
    synth_in_head = os.environ.get('CLOCKWORK_SYNTH_IN_HEAD', '0') == '1'
    fit_u = lambda Xa, ya, wa: LogisticRegression(C=4.0, max_iter=3000, class_weight='balanced').fit(Xa, ya, sample_weight=wa)
    score_u = lambda m, Xt: m.predict_proba(Xt)[:, 1]

    # One model per source: a shared model is pulled around by whichever source has the most labels.
    ok = np.zeros(len(y), bool); scored = np.zeros(len(y), bool); by_source = {}; heads = {}; detectors = {}; thresholds = {}
    for s in sorted(set(src)):
        k = src == s; kr = k & real
        if kr.sum() < 20 or len(set(y[kr])) < 2: continue
        rows = kr | (k & synth if synth_in_head else np.zeros(len(y), bool))
        pred = np.array(cv_predict(Z[rows], y[rows], w[rows], f[rows], synth[rows], fit, lambda m, Xt: m.predict(Xt)), object)
        idx = np.where(rows)[0]; got = np.array([p is not None for p in pred]) & real[rows]
        ok[idx[got]] = pred[got] == y[idx[got]]; scored[idx[got]] = True
        by_source[s] = {'labels': int(kr.sum()), 'accuracy': round(float(ok[kr & scored].mean()), 4) if (kr & scored).any() else 0.0}
        if kr.sum() >= MIN_LABELS_PER_SOURCE: heads[s] = fit(Z[rows], y[rows], w[rows])
        # Urgent detector: a separate yes/no model tuned for recall. It never decides anything itself; it only marks
        # items the student must hand to the teacher. Synthetic urgent examples train it; only real items score it.
        if yb[kr].sum() >= 5:
            sc = np.array([np.nan if v is None else v for v in cv_predict(Z[k], yb[k], w[k], f[k], synth[k], fit_u, score_u)], float); r = real[k] & ~np.isnan(sc)
            rep = urgent_report(sc[r], yb[k][r] == 1); by_source[s]['urgent'] = rep
            if rep and s in heads: detectors[s] = fit_u(Z[k], yb[k], w[k]); thresholds[s] = rep['threshold']
    trained_sources = sorted(heads)
    acc = float(ok[scored].mean()) if scored.any() else 0.0; majority = float(max(collections.Counter(y[real]).values()) / real.sum())
    served = scored & np.isin(src, trained_sources)

    meta = {'version': time.strftime('%Y%m%dT%H%M%S'), 'features': feats.VERSION, 'embedder': EMBEDDER_ID, 'labels': int(real.sum()), 'syntheticLabels': int(synth.sum()),
            'labelSources': dict(collections.Counter(r['label_source'] for r in items)), 'classBalance': dict(collections.Counter(y[real].tolist())),
            'cvAccuracy': round(acc, 4), 'servedAccuracy': round(float(ok[served].mean()) if served.any() else 0.0, 4), 'majorityBaseline': round(majority, 4),
            'bySource': by_source, 'trainedSources': trained_sources, 'urgentThresholds': thresholds}
    meta_path = os.path.join(model_dir(), 'meta.json'); prev = json.load(open(meta_path)) if os.path.exists(meta_path) else None
    # Gate: never promote a model that is worse than the one serving, or no better than guessing the majority class.
    if acc <= majority: meta.update(promoted=False, reason='no better than majority baseline')
    elif not heads: meta.update(promoted=False, reason=f'no source has {MIN_LABELS_PER_SOURCE} labels yet')
    elif prev and prev.get('promoted') and regressions(prev, by_source, trained_sources) and '--force' not in sys.argv:
        meta.update(promoted=False, reason='; '.join(regressions(prev, by_source, trained_sources)))
    elif '--dry-run' in sys.argv: meta.update(promoted=False, reason='dry run')
    else:
        tmp = os.path.join(model_dir(), 'model.joblib.tmp')
        joblib.dump({'heads': heads, 'urgent': detectors, 'scaler': scaler}, tmp); os.replace(tmp, os.path.join(model_dir(), 'model.joblib'))
        meta['promoted'] = True
        json.dump(meta, open(meta_path, 'w'), indent=1)
    json.dump(meta, open(os.path.join(model_dir(), 'last-train.json'), 'w'), indent=1)
    print(json.dumps(meta)); return 0

if __name__ == '__main__': sys.exit(main())
