"""Train the demonstration models and write metrics and model artifacts."""
import json
from pathlib import Path

import joblib
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, f1_score, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline

from data_gen import make_noshow_dataset, make_symptom_dataset

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


if __name__ == "__main__":
    metrics = {
        "specialty": train_specialty(),
        "noshow": train_noshow(),
        "data": "SYNTHETIC - replace with real de-identified data before production",
    }
    (OUTPUT / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))
