"""Synthetic demonstration-data generators; these are not clinical datasets."""
import random

import numpy as np
import pandas as pd

SPECIALTY_PHRASES = {
    "Cardiologist": [
        "chest pain", "chest tightness", "heart palpitations", "racing heartbeat",
        "shortness of breath on walking", "swollen ankles", "high blood pressure",
        "pain in left arm", "dizzy and fainting", "irregular heartbeat",
    ],
    "Neurologist": [
        "severe headache", "migraine with aura", "numbness in hand", "tingling in legs",
        "seizure", "memory loss", "tremors", "dizziness and vertigo",
        "difficulty speaking", "weakness on one side",
    ],
    "Gynecologist": [
        "irregular periods", "pelvic pain", "pregnancy check", "missed period",
        "heavy menstrual bleeding", "vaginal discharge", "menopause symptoms",
        "breast lump", "painful periods", "fertility concerns",
    ],
    "Dentist": [
        "toothache", "bleeding gums", "swollen jaw", "sensitive teeth", "broken tooth",
        "bad breath", "wisdom tooth pain", "cavity", "loose tooth", "mouth ulcer",
    ],
    "Orthopedist": [
        "knee pain", "back pain", "joint stiffness", "broken bone", "shoulder pain",
        "sprained ankle", "hip pain", "neck pain after fall", "swollen joints",
        "difficulty walking due to leg pain",
    ],
    "Physician": [
        "fever", "cough and cold", "sore throat", "stomach ache", "fatigue",
        "body aches", "loss of appetite", "diarrhea", "nausea and vomiting", "skin rash",
    ],
}
FILLERS = [
    "I have", "I am suffering from", "for the last few days I have", "my father has",
    "since yesterday there is", "I feel", "experiencing", "there is", "I noticed",
]
SUFFIX = ["", "", "for 3 days", "since last week", "and it is getting worse", "mostly at night", "please help"]


def make_symptom_dataset(n_per_class=300, seed=7):
    rng = random.Random(seed)
    rows = []
    for specialty, phrases in SPECIALTY_PHRASES.items():
        for _ in range(n_per_class):
            parts = rng.sample(phrases, rng.choice([1, 1, 2]))
            if rng.random() < 0.10:
                other = rng.choice([name for name in SPECIALTY_PHRASES if name != specialty])
                parts.append(rng.choice(SPECIALTY_PHRASES[other]))
            text = f"{rng.choice(FILLERS)} {' and '.join(parts)} {rng.choice(SUFFIX)}".strip()
            rows.append((text, specialty))
    return pd.DataFrame(rows, columns=["text", "specialty"]).sample(frac=1, random_state=seed)


def make_noshow_dataset(n=8000, seed=11):
    """Generate appointments from assumed synthetic relationships for demonstrations."""
    rng = np.random.default_rng(seed)
    lead_days = rng.integers(0, 60, n)
    hour = rng.integers(8, 19, n)
    dow = rng.integers(0, 7, n)
    previous_appointments = rng.poisson(3, n)
    previous_no_shows = np.minimum(
        rng.binomial(np.maximum(previous_appointments, 1), 0.12), previous_appointments
    )
    age = np.clip(rng.normal(40, 16, n), 1, 95).astype(int)
    reminder = rng.integers(0, 2, n)
    fee = rng.choice([400, 450, 650], n)
    logit = (
        -2.2 + 0.03 * lead_days
        + 0.9 * (previous_no_shows / np.maximum(previous_appointments, 1))
        + 0.25 * (dow >= 5) + 0.15 * (hour <= 9) - 0.8 * reminder
        + 0.001 * (fee - 450) + 0.02 * (age < 25)
    )
    probability = 1 / (1 + np.exp(-logit))
    no_show = (rng.random(n) < probability).astype(int)
    return pd.DataFrame({
        "lead_days": lead_days,
        "hour": hour,
        "dow": dow,
        "prev_appts": previous_appointments,
        "prev_noshow": previous_no_shows,
        "age": age,
        "reminder": reminder,
        "fee": fee,
        "no_show": no_show,
    })


def make_demand_series(n_products=60, days=540, seed=7):
    """Synthetic daily unit sales with weekly patterns, trends and seasonality."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2024-01-01", periods=days)
    months, weekdays = dates.month.values, dates.dayofweek.values
    series = []
    for _ in range(n_products):
        base = rng.gamma(2.0, 3.0) + 0.5
        weekly = rng.normal(1.0, 0.15, 7).clip(0.5, 1.5)
        drift = rng.normal(0, 0.0008)
        amplitude = rng.choice([0.0, 0.25, 0.5], p=[0.5, 0.3, 0.2])
        peak_month = rng.integers(1, 13)
        level = base * (1 + drift * np.arange(days)).clip(0.3)
        seasonal = 1 + amplitude * np.cos(2 * np.pi * (months - peak_month) / 12)
        mean = level * weekly[weekdays] * seasonal
        mean *= np.where(rng.random(days) < 0.01, rng.uniform(1.5, 3.0, days), 1.0)
        series.append(rng.poisson(mean))
    return dates, np.array(series)
