import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
SERVICE_KEY = "test-only-ml-service-key"


@pytest.fixture(scope="session", autouse=True)
def trained():
    if not (ROOT / "models" / "specialty.joblib").exists():
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
