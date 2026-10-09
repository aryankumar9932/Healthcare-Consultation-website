"""Feature builder shared by training and serving, so the two cannot drift apart."""
import numpy as np

HISTORY_DAYS = 28
DEMAND_FEATURES = ["lag1", "lag7", "mean7", "mean14", "mean28", "std7", "trend", "dow", "month"]


def demand_features(sales, dow, month):
    """Build features from oldest-first sales; the last value is the most recent full day."""
    recent = np.asarray(sales[-HISTORY_DAYS:], dtype=float)
    if len(recent) < HISTORY_DAYS:
        recent = np.concatenate([np.zeros(HISTORY_DAYS - len(recent)), recent])
    return {
        "lag1": recent[-1], "lag7": recent[-7],
        "mean7": recent[-7:].mean(), "mean14": recent[-14:].mean(), "mean28": recent.mean(),
        "std7": recent[-7:].std(), "trend": recent[-7:].mean() - recent.mean(),
        "dow": int(dow), "month": int(month),
    }
