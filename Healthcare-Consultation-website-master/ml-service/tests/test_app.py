import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
SERVICE_KEY = "test-only-ml-service-key"


@pytest.fixture(scope="session", autouse=True)
def trained():
    if not all((ROOT / "models" / name).exists() for name in ("specialty.joblib", "noshow.joblib", "demand.joblib")):
        import subprocess

        subprocess.check_call([sys.executable, "train.py"], cwd=ROOT)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("ML_SERVICE_KEY", SERVICE_KEY)
    sys.path.insert(0, str(ROOT))
    import app as ml_app

    return TestClient(ml_app.app, headers={"X-Service-Key": SERVICE_KEY})


def test_health(client):
    assert client.get("/health").json() == {"ok": True}


@pytest.mark.parametrize("text,expected", [
    ("I have a toothache and bleeding gums", "Dentist"),
    ("knee pain and difficulty walking", "Orthopedist"),
    ("irregular periods and pelvic pain", "Gynecologist"),
    ("migraine with numbness in hand", "Neurologist"),
])
def test_specialty(client, text, expected):
    response = client.post("/v1/specialty", json={"symptoms": text})
    assert response.status_code == 200
    assert response.json()["specialty"] == expected


def test_red_flag_overrides_model(client):
    result = client.post(
        "/v1/specialty", json={"symptoms": "sudden chest pain and sweating"}
    ).json()
    assert result["urgency"] == "urgent"
    assert result["emergency_warning"]


def test_specialty_is_limited_to_available_options(client):
    result = client.post(
        "/v1/specialty",
        json={
            "symptoms": "toothache and bleeding gums",
            "available_specialties": ["Neurologist"],
        },
    ).json()
    assert result["specialty"] == "Neurologist"


def test_noshow_estimate_is_monotonic_with_history(client):
    baseline = {
        "lead_days": 10, "hour": 10, "dow": 2, "prev_appts": 5,
        "prev_noshow": 0, "age": 35, "reminder": 1, "fee": 450,
    }
    higher_risk = {**baseline, "prev_noshow": 4, "reminder": 0, "lead_days": 50}
    first = client.post("/v1/no-show", json=baseline).json()["probability"]
    second = client.post("/v1/no-show", json=higher_risk).json()["probability"]
    assert second > first


def test_requires_service_key(client):
    response = client.post(
        "/v1/specialty",
        headers={"X-Service-Key": "wrong-key"},
        json={"symptoms": "knee pain"},
    )
    assert response.status_code == 401


def test_validation(client):
    response = client.post("/v1/no-show", json={"lead_days": -1})
    assert response.status_code == 422


def test_demand_forecast(client):
    sales = [10, 12, 9, 11, 14, 13, 10] * 4
    response = client.post("/v1/demand", json={"daily_sales": sales, "dow": 6, "month": 3, "current_stock": 20})
    assert response.status_code == 200
    body = response.json()
    assert body["horizon_days"] == 7
    assert 0 <= body["low"] <= body["forecast"] <= body["high"]
    assert 50 < body["forecast"] < 110
    assert isinstance(body["suggested_reorder"], int) and body["suggested_reorder"] >= 0
    plenty = client.post("/v1/demand", json={"daily_sales": sales, "dow": 6, "month": 3, "current_stock": 100000}).json()
    assert plenty["suggested_reorder"] == 0
    assert body["low_history"] is False


def test_demand_short_history_is_flagged(client):
    response = client.post("/v1/demand", json={"daily_sales": [3, 4, 5, 4, 3, 5, 4, 4], "dow": 1, "month": 1})
    assert response.status_code == 200
    body = response.json()
    assert body["low_history"] is True and "suggested_reorder" not in body


def test_demand_rejects_bad_input_and_missing_key(client):
    assert client.post("/v1/demand", json={"daily_sales": [1, 2], "dow": 1, "month": 1}).status_code == 422
    assert client.post("/v1/demand", json={"daily_sales": [1] * 10, "dow": 9, "month": 1}).status_code == 422
    assert client.post("/v1/demand", json={"daily_sales": [1] * 10, "dow": 1, "month": 1},
                       headers={"X-Service-Key": "wrong"}).status_code == 401
