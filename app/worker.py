import time
import threading

from app.db import get_connection
from app.engine import (
    ProviderState,
    choose_provider,
    record_provider_result,
    next_state,
    defer_until_provider_available)
from app.providers import PROVIDERS

BATCH_SIZE = 50
POLL_INTERVAL = 1

# Shared worker control state
worker_state = {
    "paused": False,
    "last_tick_at": None,
    "processed_total": 0,
    "recovered_on_start": 0
}

worker_lock = threading.Lock()


#Converting the rows of database provider table to objects of ProviderState of engine.py so that choose_provider can choose.
def load_provider_states(connection):
    rows = connection.execute(
        """
        SELECT name, channel, priority,
            consecutive_failures, open_until
        FROM providers
        ORDER BY priority
        """
    ).fetchall()

    states = []

    for row in rows:
        state = ProviderState(
            name = row["name"],
            channel = row["channel"],
            priority = row["priority"],
            consecutive_failures = row["consecutive_failures"],
            open_until = row["open_until"] or 0.0
        )
        states.append(state)

    return states

def recover_stuck_messages(connection):
    cursor = connection.execute(
        """
        UPDATE messages
        SET status = 'pending',
            locked_at = NULL
        WHERE status = 'sending'
        """
    )

    recovered_count = cursor.rowcount

    connection.commit()

    print(f"Recovered {recovered_count} stuck messages")

    return recovered_count

#Fetching and claiming: Fetching means finding messages eligible for delivery, claiming means changing status from pending to
#  sending so another worker doesnt process it at the same time
def claim_due_messages(connection, now, limit=BATCH_SIZE):

    connection.execute("BEGIN IMMEDIATE")

    try:
        rows = connection.execute(
            """
            SELECT *
            FROM messages
            WHERE status = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY
                CASE category
                    WHEN 'transactional' THEN 0
                    ELSE 1
                END,
                created_at ASC,
                id ASC
            LIMIT ?
            """,
            (now, limit)
        ).fetchall()

        claimed_messages = []

        for row in rows:
            cursor = connection.execute(
                """
                UPDATE messages
                SET status = 'sending',
                    locked_at = ?
                WHERE id = ?
                    AND status = 'pending'
                """,
                (now, row["id"])
            )

            if cursor.rowcount == 1:
                claimed_messages.append(dict(row))

        connection.commit()

        return claimed_messages

    except Exception:
        connection.rollback()
        raise

def release_claimed_messages(connection, messages):

    connection.execute("BEGIN IMMEDIATE")

    try:
        for message in messages:
            connection.execute(
                """
                UPDATE messages
                SET status = 'pending',
                    locked_at = NULL
                WHERE id = ?
                    AND status = 'sending'
                """,
                (message["id"],)
            )

        connection.commit()

    except Exception:
        connection.rollback()
        raise


def process_message(connection, message, provider_states, now):

    #Select a healthy provider
    provider_state = choose_provider(
        provider_states,
        message["channel"],
        avoid = message["last_failed_provider"],
        now = now
    )

    # If all providers are cooling down, defer the message
    if provider_state is None:

        updated_message = defer_until_provider_available(
            message,
            provider_states,
            message["channel"],
            now)
        connection.execute("BEGIN IMMEDIATE")

        try:
            cursor = connection.execute(
                """
                UPDATE messages
                SET status = ?,
                    next_attempt_at = ?,
                    locked_at = NULL
                WHERE id = ?
                    AND status = 'sending'
                """,
                (
                    updated_message["status"],
                    updated_message["next_attempt_at"],
                    message["id"]
                )
            )
            if cursor.rowcount != 1:
                raise RuntimeError("Could not defer the claimed message")

            connection.commit()

        except Exception:
            connection.rollback()
            raise

        return

    # Find the actual mock provider
    provider = next(
        p for p in PROVIDERS
        if p.name == provider_state.name
    )
    # Attempt Delivery
    provider_result, error = provider.send(message, connection)

    # Translate provider results into engine results
    result_mapping = {
        "ok": "sent",
        "transient": "temporary",
        "permanent": "permanent"
    }

    if provider_result not in result_mapping:
        raise ValueError(f"Unknown provider result: {provider_result}")

    engine_result = result_mapping[provider_result]

    #Calculate the message's next state
    updated_message = next_state(
        message["attempts"],
        engine_result,
        error,
        now
    )

    # Start a database transaction
    connection.execute("BEGIN IMMEDIATE")

    try:
        if provider_result == "ok":
            connection.execute(
                """
                INSERT OR IGNORE INTO inbox
                (message_id, provider, recipient, subject, body, delivered_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    message["id"],
                    provider.name,
                    message["recipient"],
                    message.get("subject"),
                    message["body"],
                    now
                )
            )

        # Record the delivery attempt
        connection.execute(
            """
            INSERT INTO attempts
            (message_id, attempt_no, provider, at, result, error)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                message["id"],
                updated_message["attempts"],
                provider.name,
                now,
                provider_result,
                error
            )
        )

        # Update the message
        cursor = connection.execute(
            """
            UPDATE messages
            SET status = ?,
                attempts = ?,
                next_attempt_at = ?,
                provider = ?,
                last_failed_provider = ?,
                last_error = ?,
                sent_at = ?,
                locked_at = NULL
            WHERE id = ?
                AND status = 'sending'
            """,
            (
                updated_message["status"],
                updated_message["attempts"],
                updated_message["next_attempt_at"],
                provider.name,
                provider.name if engine_result != "sent" else None,
                updated_message["last_error"],
                now if engine_result == "sent" else None,
                message["id"]
            )
        )

        if cursor.rowcount != 1:
            raise RuntimeError("Could not update the claimed message")

        # Update the in-memory provider state
        record_provider_result(
            provider_state,
            engine_result,
            now
        )

        # Save the provider state in SQlite
        connection.execute(
            """
            UPDATE providers
            SET consecutive_failures = ?,
                open_until = ?
            WHERE name = ?
            """,
            (
                provider_state.consecutive_failures,
                provider_state.open_until,
                provider_state.name
            )
        )

        if connection.execute("SELECT changes()").fetchone()[0] != 1:
            raise RuntimeError("Could not update provider state")

        # Commit all the worker database updates
        connection.commit()

    except Exception:
        connection.rollback()
        raise

def tick(now):
    connection = get_connection()

    try:
        provider_states = load_provider_states(connection)

        messages = claim_due_messages(connection,now)

        processed_count = 0

        for index, message in enumerate(messages):
            try:
                process_message(
                    connection,
                    message,
                    provider_states,
                    now
                )
                processed_count += 1

            except Exception:
                # Release the failed message and all remaining claimed messages
                release_claimed_messages(
                    connection,
                    messages[index:]
                )
                raise
        return processed_count

    finally:
        connection.close()

def worker_loop(stop_event):
    print("Background worker started")

    while not stop_event.is_set():
        if not worker_state["paused"]:
            if worker_lock.acquire(blocking=False):
                try:
                    processed_count = tick(time.time())
                    worker_state["last_tick_at"] = time.time()
                    worker_state["processed_total"] += processed_count
                except Exception as error:
                    print(f"Worker error: {error}")
                finally:
                    worker_lock.release()

        stop_event.wait(POLL_INTERVAL)

    print("Background worker stopped")

def start_worker():
    stop_event = threading.Event()

    thread = threading.Thread(
        target=worker_loop,
        args=(stop_event,),
        daemon=True
    )

    thread.start()

    return stop_event, thread

def manual_tick():
    if not worker_lock.acquire(blocking=False):
        return None

    try:
        processed_count = tick(time.time())

        worker_state["last_tick_at"] = time.time()
        worker_state["processed_total"] += processed_count

        return processed_count

    finally:
        worker_lock.release()