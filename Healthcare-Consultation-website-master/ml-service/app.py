"""CareConnect local ML service.

The included models are trained on synthetic demonstration data and are not
validated for clinical or operational decisions.
"""
import logging
import os
import re
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from features import demand_features

MODELS = Path(__file__).parent / "models"
API_KEY = os.environ.get("ML_SERVICE_KEY", "")
NOSHOW_FEATURES = ["lead_days", "hour", "dow", "prev_appts", "prev_noshow", "age", "reminder", "fee"]

app = FastAPI(title="CareConnect ML", version="1.0.0")
_state = {}


def _load():
    if not {"specialty", "noshow"}.issubset(_state):
        models = {
            "specialty": joblib.load(MODELS / "specialty.joblib"),
            "noshow": joblib.load(MODELS / "noshow.joblib"),
        }
        _state.update(models)
    return _state


def _load_demand():
    # Keep existing endpoints available when an older deployment lacks demand.joblib.
    if "demand" not in _state:
        _state["demand"] = joblib.load(MODELS / "demand.joblib")
    return _state["demand"]


RED_FLAGS = [
    r"chest pain", r"can.?t breathe|difficulty breathing|short(ness)? of breath at rest",
    r"stroke|face drooping|slurred speech|difficulty speaking", r"seizure",
    r"unconscious|fainted|passed out", r"severe bleeding|vomiting blood|coughing blood",
    r"suicid|kill myself|end my life", r"worst headache",
]
RED_RE = re.compile("|".join(RED_FLAGS), re.I)
URGENT_HINTS = re.compile(r"high fever|getting worse|severe|unbearable|swollen jaw|broken", re.I)


def auth(key):
    if not API_KEY:
        raise HTTPException(503, "ML service key is not configured")
    if key != API_KEY:
        raise HTTPException(401, "invalid service key")


class SpecialtyIn(BaseModel):
    symptoms: str = Field(min_length=3, max_length=1500)
    available_specialties: list[str] | None = None


class NoShowIn(BaseModel):
    lead_days: int = Field(ge=0, le=365)
    hour: int = Field(ge=0, le=23)
    dow: int = Field(ge=0, le=6)
    prev_appts: int = Field(ge=0, le=1000)
    prev_noshow: int = Field(ge=0, le=1000)
    age: int = Field(ge=0, le=120, default=40)
    reminder: int = Field(ge=0, le=1, default=1)
    fee: int = Field(ge=0, le=100000, default=450)


class DemandIn(BaseModel):
    daily_sales: list[int] = Field(min_length=7, max_length=120)
    dow: int = Field(ge=0, le=6)
    month: int = Field(ge=1, le=12)
    current_stock: int | None = Field(default=None, ge=0, le=1_000_000)


@app.get("/health")
def health():
    try:
        _load()
        return {"ok": True}
    except Exception as error:  # pragma: no cover
        logging.exception("CareConnect ML models failed to load")
        raise HTTPException(503, "ML models are unavailable") from error


@app.post("/v1/specialty")
def specialty(body: SpecialtyIn, x_service_key: str = Header(default="")):
    auth(x_service_key)
    pipe = _load()["specialty"]
    probs = pipe.predict_proba([body.symptoms])[0]
    ranked = sorted(zip(pipe.classes_, probs), key=lambda item: -item[1])
    if body.available_specialties:
        allowed = {item.lower() for item in body.available_specialties}
        matching = [item for item in ranked if item[0].lower() in allowed]
        if matching:
            ranked = matching
    emergency = bool(RED_RE.search(body.symptoms))
    top, confidence = ranked[0]
    urgency = "urgent" if emergency else (
        "soon" if URGENT_HINTS.search(body.symptoms) else "routine"
    )
    return {
        "specialty": top,
        "confidence": round(float(confidence), 3),
        "alternatives": [
            {"specialty": name, "confidence": round(float(value), 3)}
            for name, value in ranked[1:3]
        ],
        "urgency": urgency,
        "emergency_warning": (
            "Possible emergency. Call your local emergency number now." if emergency else None
        ),
        "low_confidence": bool(confidence < 0.45),
        "model_version": "tfidf-logreg-1",
        "disclaimer": "General guidance only, not a diagnosis.",
    }


@app.post("/v1/no-show")
def no_show(body: NoShowIn, x_service_key: str = Header(default="")):
    auth(x_service_key)
    model = _load()["noshow"]
    row = pd.DataFrame([body.model_dump()])[NOSHOW_FEATURES]
    probability = float(model.predict_proba(row)[0, 1])
    risk = "high" if probability >= 0.35 else "moderate" if probability >= 0.2 else "low"
    return {
        "probability": round(probability * 100, 1),
        "risk": risk,
        "model_version": "hgb-calibrated-1",
        "suggested_action": "send an extra reminder" if risk != "low" else None,
        "disclaimer": "Synthetic experimental estimate only; never use it to deny or delay care.",
    }


@app.post("/v1/demand")
def demand(body: DemandIn, x_service_key: str = Header(default="")):
    auth(x_service_key)
    if any(value < 0 or value > 100_000 for value in body.daily_sales):
        raise HTTPException(422, "daily_sales values must be between 0 and 100000")
    try:
        bundle = _load_demand()
    except Exception as error:  # pragma: no cover
        logging.exception("CareConnect demand model failed to load")
        raise HTTPException(503, "Demand model is unavailable") from error
    row = pd.DataFrame([demand_features(body.daily_sales, body.dow, body.month)])[bundle["features"]]
    low, mid, high = sorted(float(bundle["models"][q].predict(row)[0]) for q in (0.1, 0.5, 0.9))
    low, mid, high = (max(0.0, value) for value in (low, mid, high))
    result = {
        "horizon_days": bundle["horizon"],
        "forecast": round(mid, 1),
        "low": round(low, 1),
        "high": round(high, 1),
        "low_history": len(body.daily_sales) < 28,
        "model_version": "hgb-quantile-1",
        "disclaimer": "Synthetic experimental forecast; check against real stock and supplier lead times.",
    }
    if body.current_stock is not None:
        result["suggested_reorder"] = int(max(0, np.ceil(high - body.current_stock)))
    return result
