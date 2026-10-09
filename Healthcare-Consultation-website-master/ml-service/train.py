"""Train the demonstration models and write metrics and model artifacts."""
import json
from pathlib import Path

import joblib
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, f1_score, mean_absolute_error, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
import numpy as np
import pandas as pd

from data_gen import make_demand_series, make_noshow_dataset, make_symptom_dataset
from features import DEMAND_FEATURES, HISTORY_DAYS, demand_features

OUTPUT = Path(__file__).parent / "models"
OUTPUT.mkdir(exist_ok=True)
NOSHOW_FEATURES = [
    "lead_days", "hour", "dow", "prev_appts", "prev_noshow", "age", "reminder", "fee",
]


def train_specialty():
    data = make_symptom_dataset()
    train_x, test_x, train_y, test_y = train_test_split(
        data.text, data.specialty, test_size=0.2, stratify=data.specialty, random_state=1
    )
    pipeline = make_pipeline(
        TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True),
        LogisticRegression(max_iter=1000, C=4.0),
    )
    pipeline.fit(train_x, train_y)
    prediction = pipeline.predict(test_x)
    metrics = {
        "accuracy": accuracy_score(test_y, prediction),
        "macro_f1": f1_score(test_y, prediction, average="macro"),
        "n_test": len(test_y),
    }
    joblib.dump(pipeline, OUTPUT / "specialty.joblib")
    return metrics


def train_noshow():
    data = make_noshow_dataset()
    features, labels = data[NOSHOW_FEATURES], data.no_show
    train_x, test_x, train_y, test_y = train_test_split(
        features, labels, test_size=0.2, stratify=labels, random_state=1
    )
    base = HistGradientBoostingClassifier(
        max_depth=4, learning_rate=0.06, max_iter=200, random_state=1
    )
    model = CalibratedClassifierCV(base, method="isotonic", cv=3).fit(train_x, train_y)
    probability = model.predict_proba(test_x)[:, 1]
    metrics = {
        "roc_auc": roc_auc_score(test_y, probability),
        "brier": brier_score_loss(test_y, probability),
        "base_rate": float(labels.mean()),
        "n_test": len(test_y),
    }
    joblib.dump(model, OUTPUT / "noshow.joblib")
    return metrics


HORIZON = 7
QUANTILES = (0.1, 0.5, 0.9)


def _demand_rows(dates, series, start, stop):
    """Rows use only prior sales; every target window stays within [start, stop)."""
    rows = []
    for product, daily in enumerate(series):
        final_start = min(stop - HORIZON + 1, len(daily) - HORIZON + 1)
        for t in range(max(start, HISTORY_DAYS), final_start):
            row = demand_features(daily[:t], dates[t - 1].dayofweek, dates[t - 1].month)
            row["target"] = float(daily[t:t + HORIZON].sum())
            row["product"] = product
            rows.append(row)
    return pd.DataFrame(rows)


def train_demand():
    dates, series = make_demand_series()
    cut = int(series.shape[1] * 0.8)
    train = _demand_rows(dates, series, 0, cut)
    test = _demand_rows(dates, series, cut, series.shape[1])
    models = {}
    for q in QUANTILES:
        models[q] = HistGradientBoostingRegressor(
            loss="quantile", quantile=q, max_depth=4, learning_rate=0.06, max_iter=200, random_state=1
        ).fit(train[DEMAND_FEATURES], train.target)
    median = models[0.5].predict(test[DEMAND_FEATURES])
    low = models[0.1].predict(test[DEMAND_FEATURES])
    high = models[0.9].predict(test[DEMAND_FEATURES])
    baseline = test.mean7 * HORIZON
    metrics = {
        "mae_model": float(mean_absolute_error(test.target, median)),
        "mae_naive_baseline": float(mean_absolute_error(test.target, baseline)),
        "interval_80_coverage": float(np.mean((test.target >= low) & (test.target <= high))),
        "n_test": int(len(test)),
    }
    joblib.dump({"models": models, "features": DEMAND_FEATURES, "horizon": HORIZON}, OUTPUT / "demand.joblib")
    return metrics


if __name__ == "__main__":
    metrics = {
        "specialty": train_specialty(),
        "noshow": train_noshow(),
        "demand": train_demand(),
        "data": "SYNTHETIC - replace with real de-identified data before production",
    }
    (OUTPUT / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))
