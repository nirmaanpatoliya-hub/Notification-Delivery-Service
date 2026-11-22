
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import auth, db, main


@pytest.fixture
def client(monkeypatch, tmp_path):
    # Use a separate database for API tests
    test_db_path = tmp_path / "test_dakghar.db"
    monkeypatch.setattr(db, "DB_PATH", test_db_path)

    # Use test-only API keys
    monkeypatch.setattr(auth, "ADMIN_KEY", "test-admin-key")
    monkeypatch.setattr(auth, "SENDER_KEY", "test-sender-key")

    # Start and stop the application properly
    with TestClient(app) as test_client:
        yield test_client


def test_health_is_public(client):
    response = client.get("/health")

    assert response.status_code == 200


def test_protected_route_without_key(client):
    response = client.get("/api/providers")

    assert response.status_code == 401


def test_protected_route_with_invalid_key(client):
    response = client.get(
        "/api/providers",
        headers={"X-Api-Key": "wrong-key"}
    )

    assert response.status_code == 403


def test_protected_route_with_sender_key(client):
    response = client.get(
        "/api/providers",
        headers={"X-Api-Key": "test-sender-key"}
    )

    assert response.status_code == 200


def test_protected_route_with_admin_key(client):
    response = client.get(
        "/api/providers",
        headers={"X-Api-Key": "test-admin-key"}
    )

    assert response.status_code == 200

def test_sender_cannot_pause_worker(client):
    response = client.patch(
        "/api/worker",
        headers={"X-Admin-Key": "test-sender-key"},
        json={"paused": True}
    )

    assert response.status_code == 403


def test_admin_can_pause_worker(client):
    response = client.patch(
        "/api/worker",
        headers={"X-Admin-Key": "test-admin-key"},
        json={"paused": True}
    )

    assert response.status_code == 200
    assert response.json()["paused"] is True


def test_admin_can_resume_worker(client):
    response = client.patch(
        "/api/worker",
        headers={"X-Admin-Key": "test-admin-key"},
        json={"paused": False}
    )

    assert response.status_code == 200
    assert response.json()["paused"] is False

def test_sender_cannot_run_manual_tick(client):
    response = client.post(
        "/api/worker/tick",
        headers={"X-Admin-Key": "test-sender-key"}
    )

    assert response.status_code == 403


def test_admin_can_run_manual_tick(client, monkeypatch):
    monkeypatch.setattr(main, "manual_tick", lambda: 3)

    response = client.post(
        "/api/worker/tick",
        headers={"X-Admin-Key": "test-admin-key"}
    )

    assert response.status_code == 200
    assert response.json()["processed"] == 3


def test_manual_tick_returns_409_when_worker_busy(client, monkeypatch):
    monkeypatch.setattr(main, "manual_tick", lambda: None)

    response = client.post(
        "/api/worker/tick",
        headers={"X-Admin-Key": "test-admin-key"}
    )

    assert response.status_code == 409
    assert response.json()["error"] == "worker_busy"

def test_sender_can_view_worker_status(client):
    response = client.get(
        "/api/worker",
        headers={"X-Api-Key": "test-sender-key"}
    )

    assert response.status_code == 200
    assert "paused" in response.json()
    assert "last_tick_at" in response.json()
    assert "processed_total" in response.json()
    assert "recovered_on_start" in response.json()


def test_admin_can_view_worker_status(client):
    response = client.get(
        "/api/worker",
        headers={"X-Api-Key": "test-admin-key"}
    )

    assert response.status_code == 200

def test_admin_can_enable_provider_outage(client):
    response = client.patch(
        "/api/providers/mailfast",
        headers={"X-Admin-Key": "test-admin-key"},
        json={"outage": True}
    )

    assert response.status_code == 200
    assert response.json()["outage"] == 1


def test_sender_cannot_update_provider(client):
    response = client.patch(
        "/api/providers/mailfast",
        headers={"X-Admin-Key": "test-sender-key"},
        json={"outage": True}
    )

    assert response.status_code == 403


def test_provider_fail_rate_out_of_range(client):
    response = client.patch(
        "/api/providers/mailfast",
        headers={"X-Admin-Key": "test-admin-key"},
        json={"fail_rate": 0.8}
    )

    assert response.status_code == 400
    assert response.json()["error"] == "out_of_range"


def test_unknown_provider_returns_404(client):
    response = client.patch(
        "/api/providers/unknown",
        headers={"X-Admin-Key": "test-admin-key"},
        json={"outage": True}
    )

    assert response.status_code == 404
    assert response.json()["error"] == "provider_not_found"

def test_sender_cannot_reset_database(client):
    response = client.post(
        "/api/admin/reset",
        headers={"X-Admin-Key": "test-sender-key"}
    )

    assert response.status_code == 403


def test_admin_can_reset_database(client):
    response = client.post(
        "/api/admin/reset",
        headers={"X-Admin-Key": "test-admin-key"}
    )

    assert response.status_code == 200
    assert response.json() == {
        "reset": True,
        "messages": 5
    }


def test_reset_restores_five_messages(client):
    client.post(
        "/api/admin/reset",
        headers={"X-Admin-Key": "test-admin-key"}
    )

    response = client.get(
        "/api/messages",
        headers={"X-Api-Key": "test-admin-key"}
    )

    assert response.status_code == 200
    assert sum(response.json()["counts"].values()) == 5

def test_health_endpoint(client):
    response = client.get("/health")

    assert response.status_code == 200

    data = response.json()

    assert data["status"] == "ok"
    assert "pending" in data
    assert data["worker"] in ("running", "paused")