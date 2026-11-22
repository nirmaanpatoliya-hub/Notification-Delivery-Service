from typing import Optional
import os
import secrets

from dotenv import load_dotenv
from fastapi import Header, HTTPException

load_dotenv()

ADMIN_KEY = os.getenv("ADMIN_KEY")
SENDER_KEY = os.getenv("SENDER_KEY")


def require_sender(
    x_api_key: Optional[str] = Header(default=None, alias="X-Api-Key"),
):
    if not x_api_key:
        raise HTTPException(
            status_code=401,
            detail={
                "error": "missing_api_key",
                "detail": "An API key is required."
            }
        )

    if (
        (SENDER_KEY and secrets.compare_digest(x_api_key, SENDER_KEY))
        or (ADMIN_KEY and secrets.compare_digest(x_api_key, ADMIN_KEY))
    ):
        return "authenticated"

    raise HTTPException(
        status_code=403,
        detail={
            "error": "invalid_api_key",
            "detail": "The provided API key is invalid."
        }
    )

def require_admin(
    x_admin_key: Optional[str] = Header(default=None, alias="X-Admin-Key"),
):
    if not x_admin_key:
        raise HTTPException(
            status_code=401,
            detail={
                "error": "missing_admin_key",
                "detail": "An admin API key is required."
            }
        )

    if not ADMIN_KEY or not secrets.compare_digest(x_admin_key, ADMIN_KEY):
        raise HTTPException(
            status_code=403,
            detail={
                "error": "admin_access_required",
                "detail": "A valid admin API key is required."
            }
        )

    return "admin"
