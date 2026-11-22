import re
import time
import sqlite3

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.db import get_connection, initialize_database
from app.models import MessageCreate
from app.worker import start_worker, recover_stuck_messages

app = FastAPI()

#Initialize database when the API starts
@app.on_event("startup")
def startup():
    initialize_database()

    connection = get_connection()

    try:
        recover_stuck_messages(connection)
    finally:
        connection.close()

    app.state.worker_stop_event, app.state.worker_thread = start_worker()

# Shutdown process
@app.on_event("shutdown")
def shutdown():
    app.state.worker_stop_event.set()
    app.state.worker_thread.join()

    print("Dakghar application shut down successfully")

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

#Health Check
@app.get("/health")
def health_check():
    return {"status": "healthy"}

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

#Create a notification
@app.post("/api/messages", status_code=201)
def create_message(message: MessageCreate):

    validate_message(message)

    connection = get_connection()   

    try:
        pending_count = connection.execute(
            "SELECT COUNT(*) FROM messages WHERE status = 'pending'"
        ).fetchone()[0]

        if pending_count >= 10000:
            api_error(503, "queue_full", "Pending message queue is full")

        created_at = time.time()

        cursor = connection.execute(
            """
            INSERT INTO messages
            (channel, category, recipient, subject, body, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
            """,
            (
                message.channel,
                message.category,
                message.to,
                message.subject,
                message.body,
                created_at
            )
        )

        message_id = cursor.lastrowid

        #commit before return success
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
@app.get("/api/messages")
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
@app.get("/api/messages/{message_id}")
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
@app.get("/api/providers")
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


#Retrieve inbox messages
@app.get("/api/inbox")
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