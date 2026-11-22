
import pytest
from fastapi import HTTPException

from app import auth


@pytest.fixture
def test_keys(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_KEY", "test-admin-key")
    monkeypatch.setattr(auth, "SENDER_KEY", "test-sender-key")


def test_sender_missing_key(test_keys):
    with pytest.raises(HTTPException) as error:
        auth.require_sender(None)

    assert error.value.status_code == 401


def test_sender_invalid_key(test_keys):
    with pytest.raises(HTTPException) as error:
        auth.require_sender("wrong-key")

    assert error.value.status_code == 403


def test_sender_key_allowed(test_keys):
    result = auth.require_sender("test-sender-key")

    assert result == "authenticated"


def test_admin_key_allowed_on_sender_route(test_keys):
    result = auth.require_sender("test-admin-key")

    assert result == "authenticated"


def test_sender_key_denied_admin_route(test_keys):
    with pytest.raises(HTTPException) as error:
        auth.require_admin("test-sender-key")

    assert error.value.status_code == 403


def test_admin_key_allowed_admin_route(test_keys):
    result = auth.require_admin("test-admin-key")

    assert result == "admin"

