import re
import time
import sqlite3
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, Depends
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

from app.db import get_connection, initialize_database, reset_database
from app.models import MessageCreate, WorkerUpdate, ProviderUpdate
from app.worker import (
    start_worker,
    recover_stuck_messages,
    worker_state,
    manual_tick,
    worker_lock
)
from app.auth import require_sender, require_admin

@asynccontextmanager
async def lifespan(app: FastAPI):

    # Startup
    initialize_database()

    connection = get_connection()

    try:
        recovered_count = recover_stuck_messages(connection)
    finally:
        connection.close()

    worker_state["recovered_on_start"] = recovered_count

    app.state.worker_stop_event, app.state.worker_thread = start_worker()

    try:
        yield

    finally:
        # Shutdown
        app.state.worker_stop_event.set()
        app.state.worker_thread.join()

        print("Dakghar application shut down successfully")


app = FastAPI(lifespan=lifespan)

STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/static/send.html")

#Consistent API error response
def api_error(status_code, code, detail):
    raise HTTPException(
        status_code=status_code,
        detail={
            "error": code,
            "detail": detail
        }
    )

#custom exception handler
@app.exception_handler(HTTPException)
async def http_error_handler(request: Request, exc: HTTPException):
    if isinstance(exc.detail, dict):
        content = exc.detail
    else:
        content = {
            "error": "http_error",
            "detail" : str(exc.detail)
        }

    return JSONResponse(
        status_code= exc.status_code,
        content= content
    )      

@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=400,
        content={
            "error": "invalid_request",
            "detail": "Invalid request data or query parameters"
        }
    )

@app.get("/api/worker", dependencies=[Depends(require_sender)])
def get_worker_status():
    return {
        "paused": worker_state["paused"],
        "last_tick_at": worker_state["last_tick_at"],
        "processed_total": worker_state["processed_total"],
        "recovered_on_start": worker_state["recovered_on_start"]
    }

@app.patch("/api/worker", dependencies=[Depends(require_admin)])
def update_worker_status(payload: WorkerUpdate):
    worker_state["paused"] = payload.paused

    return {
        "paused": worker_state["paused"]
    }

@app.post("/api/worker/tick", dependencies=[Depends(require_admin)])
def run_manual_tick():
    processed_count = manual_tick()

    if processed_count is None:
        api_error(
            409,
            "worker_busy",
            "The worker is currently processing messages."
        )

    return {
        "processed": processed_count
    }


# Health Check
@app.get("/health")
def health_check():
    connection = get_connection()

    try:
        pending_count = connection.execute(
            "SELECT COUNT(*) FROM messages WHERE status = 'pending'"
        ).fetchone()[0]

        return {
            "status": "ok",
            "pending": pending_count,
            "worker": "paused" if worker_state["paused"] else "running"
        }

    finally:
        connection.close()

#Validate incoming notification
def validate_message(message):

    if message.channel not in ("email", "sms"):
        api_error(400, "invalid_channel", "Channel must be email or sms")

    if message.category not in ("transactional", "marketing"):
        api_error(400, "invalid_category", "Invalid message category")

    if message.channel == "email":

        email_pattern = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"

        if (len(message.to) > 254
        or not re.fullmatch(email_pattern, message.to)
        ):
            api_error(400, "invalid_recipient", "Invalid email recipient")

        if not message.subject:
            api_error(400, "subject_required", "Email subject is required")

        if len(message.subject) > 150:
            api_error(400, "invalid_subject", "Email subject cannot exceed 150 characters")

        if not 1 <= len(message.body) <= 2000:
            api_error(400, "body_too_long", "Email body must contain 1 to 2000 characters")

    else:
        phone_pattern = r"^\+[1-9][0-9]{7,14}$"

        if not re.fullmatch(phone_pattern, message.to):
            api_error(400, "invalid_recipient", "Invalid SMS recipient")

        if not 1 <= len(message.body) <= 480:
            api_error(400, "body_too_long", "SMS body must contain 1 to 480 characters")


# Create a notification
@app.post("/api/messages", status_code=201, dependencies=[Depends(require_sender)])
def create_message(message: MessageCreate):

    validate_message(message)

    connection = get_connection()

    try:
        # Start a write transaction to prevent duplicate-key race conditions
        connection.execute("BEGIN IMMEDIATE")

        # Check whether this idempotency key was already used
        if message.idempotency_key:
            existing = connection.execute(
                """
                SELECT id, channel, category, recipient, subject, body,
                       status, created_at
                FROM messages
                WHERE idempotency_key = ?
                """,
                (message.idempotency_key,)
            ).fetchone()

            if existing:
                same_request = (
                    existing["channel"] == message.channel
                    and existing["category"] == message.category
                    and existing["recipient"] == message.to
                    and existing["subject"] == message.subject
                    and existing["body"] == message.body
                )

                if not same_request:
                    api_error(
                        409,
                        "idempotency_key_conflict",
                        "Idempotency key was already used with a different request"
                    )

                connection.commit()

                return {
                    "id": existing["id"],
                    "status": "pending",
                    "created_at": existing["created_at"]
                }

        # Check queue capacity only for genuinely new requests
        pending_count = connection.execute(
            "SELECT COUNT(*) FROM messages WHERE status = 'pending'"
        ).fetchone()[0]

        if pending_count >= 10000:
            api_error(503, "queue_full", "Pending message queue is full")

        created_at = time.time()

        cursor = connection.execute(
            """
            INSERT INTO messages
            (channel, category, recipient, subject, body,
             status, created_at, idempotency_key)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
            """,
            (
                message.channel,
                message.category,
                message.to,
                message.subject,
                message.body,
                created_at,
                message.idempotency_key
            )
        )

        message_id = cursor.lastrowid

        connection.commit()

        return {
            "id": message_id,
            "status": "pending",
            "created_at": created_at
        }

    except HTTPException:
        connection.rollback()
        raise

    except sqlite3.Error:
        connection.rollback()
        api_error(500, "database_error", "Message could not be saved")

    finally:
        connection.close()


#Retreive messages
@app.get("/api/messages", dependencies=[Depends(require_sender)])
def get_messages(
    status: str = None,
    channel: str= None,
    category: str = None,
    before_id: int = None,
    limit: int = Query(default = 50, ge=1, le=200)
):

    allowed_statuses = ("pending", "sending", "sent", "failed")

    if status is not None and status not in allowed_statuses:
        api_error(400, "bad_filter", "Invalid status filter")

    if channel is not None and channel not in ("email", "sms"):
        api_error(400, "bad_filter", "Invalid channel filter")

    if category is not None and category not in ("transactional","marketing"):
        api_error(400, "bad_filter", "Invalid category filter")

    connection = get_connection()

    try:
        counts = {
            "pending": 0,
            "sending": 0,
            "sent": 0,
            "failed": 0
        }

        rows = connection.execute(
            "SELECT status, COUNT(*) AS total FROM messages GROUP BY status"
        ).fetchall()

        for row in rows:
            counts[row["status"]]= row["total"]

        query = " SELECT * FROM messages WHERE 1=1"
        params= []

        if status is not None:
            query += " AND status = ?"
            params.append(status)

        if channel is not None:
            query += " AND channel = ?"
            params.append(channel)

        if category is not None:
            query += " AND category = ?"
            params.append(category)

        if before_id is not None:
            query += " AND id < ?"
            params.append(before_id)

        query += " ORDER BY id DESC LIMIT ?"
        params.append(limit)

        messages = connection.execute(query,params).fetchall()

        return {
            "counts": counts,
            "messages": [dict(row) for row in messages]
        }

    finally:
        connection.close()

#Retrieve one message with its attempt history
@app.get("/api/messages/{message_id}", dependencies=[Depends(require_sender)])
def get_message(message_id: int):

    connection = get_connection()

    try:
        message = connection.execute(
            " SELECT * FROM messages WHERE id = ?",
            (message_id,)
        ).fetchone()

        if message is None:
            api_error(404, "message_not_found", "Message does not exist")

        attempts = connection.execute(
            """
                SELECT attempt_no, provider, at, result, error
                FROM attempts
                WHERE message_id = ?
                ORDER BY attempt_no 
            """,
            (message_id,)
        ).fetchall()

        result = dict(message)
        result["attempts_log"] = [dict(row) for row in attempts]

        return result

    finally:
        connection.close()

#Retrieve providers
@app.get("/api/providers", dependencies=[Depends(require_sender)])
def get_providers():

    connection = get_connection()

    try:
        rows = connection.execute(
            " SELECT * FROM providers ORDER BY channel, priority"
        ).fetchall()

        providers = []

        for row in rows:
            provider = dict(row)

            if provider["outage"]:
                provider["state"] = "outage simulated"
            elif provider["open_until"] and provider["open_until"] > time.time():
                provider["state"] = "cooldown"
            else:
                provider["state"] = "healthy"

            providers.append(provider)

        return providers

    finally:
        connection.close()

@app.patch("/api/providers/{name}", dependencies=[Depends(require_admin)])
def update_provider(name: str, payload: ProviderUpdate):
    updates = payload.model_dump(exclude_unset=True)

    if "fail_rate" in updates:
        if not 0.0 <= updates["fail_rate"] <= 0.5:
            api_error(
                400,
                "out_of_range",
                "Failure rate must be between 0.0 and 0.5."
            )

    if not updates:
        api_error(
            400,
            "invalid_request",
            "At least one provider setting must be supplied."
        )

    connection = get_connection()

    try:
        provider = connection.execute(
            "SELECT name FROM providers WHERE name = ?",
            (name,)
        ).fetchone()

        if provider is None:
            api_error(
                404,
                "provider_not_found",
                "The requested provider does not exist."
            )

        if "outage" in updates:
            connection.execute(
                "UPDATE providers SET outage = ? WHERE name = ?",
                (int(updates["outage"]), name)
            )

        if "fail_rate" in updates:
            connection.execute(
                "UPDATE providers SET fail_rate = ? WHERE name = ?",
                (updates["fail_rate"], name)
            )

        connection.commit()

        updated_provider = connection.execute(
            "SELECT name, channel, priority, fail_rate, outage "
            "FROM providers WHERE name = ?",
            (name,)
        ).fetchone()

        return dict(updated_provider)

    finally:
        connection.close()

@app.post("/api/admin/reset", dependencies=[Depends(require_admin)])
def admin_reset():

    worker_lock.acquire()

    try:
        reset_database()

        return {
            "reset": True,
            "messages": 5
        }

    finally:
        worker_lock.release()

#Retrieve inbox messages
@app.get("/api/inbox", dependencies=[Depends(require_sender)])
def get_inbox(
    provider: str = None,
    limit: int = Query(default=50, ge=1, le= 200)
):

    connection = get_connection()

    try:
        query=  """
                SELECT message_id, provider, recipient, subject ,body, delivered_at
                FROM inbox
                WHERE 1=1
                """

        params= []

        if provider is not None:
            query += " AND provider = ?"
            params.append(provider)

        query += " ORDER BY delivered_at DESC LIMIT ?"
        params.append(limit)

        rows = connection.execute(query, params).fetchall()

        return [dict(row) for row in rows]

    finally:
        connection.close()