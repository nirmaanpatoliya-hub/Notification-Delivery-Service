import pytest

from app import db
from app.worker import tick, recover_stuck_messages
import app.worker as worker

@pytest.fixture
def test_db(monkeypatch, tmp_path):
    # Create a seperate database for this test
    test_databse_path = tmp_path / "test_dakghar.db"

    # Redirect the application's database path
    monkeypatch.setattr(db, "DB_PATH", test_databse_path)

    # Intialize tables and seed providers
    db.initialize_database()

    connection = db.get_connection()

    # Remove sample messages, if any
    connection.execute("DELETE FROM messages")
    connection.commit()
    try:
        yield connection
    finally:
        connection.close()

def test_database_fixture(test_db):
    providers = test_db.execute(
        "SELECT name FROM providers ORDER BY priority"
    ).fetchall()

    messages = test_db.execute(
        "SELECT * FROM messages"
    ).fetchall()

    assert len(providers) == 4
    assert len(messages) == 0

def test_worker_retries_with_backup_provider(test_db):

    # Create one email notification
    cursor = test_db.execute(
        """
        INSERT INTO messages
        (channel, category, recipient, subject, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            "email",
            "transactional",
            "test@example.com",
            "Test notification",
            "Testing provider fallback",
            100
        )
    )

    message_id = cursor.lastrowid

    # Simulate a complete outage at the primary provider
    test_db.execute(
        """
        UPDATE providers
        SET outage = 1, fail_rate = 0
        WHERE name = 'mailfast'
        """
    )

    test_db.commit()

    # First attempt: mailfast should fail
    processed = tick(100)

    assert processed == 1

    message = test_db.execute(
        "SELECT * FROM messages WHERE id = ?",
        (message_id,)
    ).fetchone()

    assert message["status"] == "pending"
    assert message["attempts"] == 1
    assert message["last_failed_provider"] == "mailfast"
    assert message["next_attempt_at"] == 102

        # Remove randomness from the backup provider too
    test_db.execute(
        """
        UPDATE providers
        SET fail_rate = 0
        WHERE name = 'postbird'
        """
    )
    test_db.commit()

    # Second attempt: postbird should deliver successfully
    processed = tick(102)

    assert processed == 1

    message = test_db.execute(
        "SELECT * FROM messages WHERE id = ?",
        (message_id,)
    ).fetchone()

    assert message["status"] == "sent"
    assert message["attempts"] == 2
    assert message["provider"] == "postbird"

    # Verify both delivery attempts were recorded
    attempts = test_db.execute(
        """
        SELECT provider, result, attempt_no
        FROM attempts
        WHERE message_id = ?
        ORDER BY attempt_no
        """,
        (message_id,)
    ).fetchall()

    assert len(attempts) == 2

    assert attempts[0]["provider"] == "mailfast"
    assert attempts[0]["result"] == "transient"

    assert attempts[1]["provider"] == "postbird"
    assert attempts[1]["result"] == "ok"

    # Verify the successful delivery appears in the inbox
    inbox = test_db.execute(
        """
        SELECT * FROM inbox
        WHERE message_id = ?
        """,
        (message_id,)
    ).fetchall()

    assert len(inbox) == 1
    assert inbox[0]["provider"] == "postbird"

def test_circuit_breaker_opens_after_two_failures(test_db):

    # Simulate an outage at the primary email provider
    test_db.execute(
        """
        UPDATE providers
        SET outage = 1, fail_rate = 0
        WHERE name = 'mailfast'
        """
    )
    test_db.commit()

    # Create an email message
    cursor = test_db.execute(
        """
        INSERT INTO messages
        (channel, category, recipient, subject, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            "email",
            "transactional",
            "circuit@example.com",
            "Circuit breaker test",
            "Testing consecutive failures",
            100
        )
    )

    message_id = cursor.lastrowid
    test_db.commit()

        # First temporary failure at time 100
    tick(100)

    provider = test_db.execute(
        "SELECT * FROM providers WHERE name = 'mailfast'"
    ).fetchone()

    assert provider["consecutive_failures"] == 1
    assert provider["open_until"] == 0

        # Simulate an outage at the backup provider too
    test_db.execute(
        """
        UPDATE providers
        SET outage = 1, fail_rate = 0
        WHERE name = 'postbird'
        """
    )
    test_db.commit()

    # Second message attempt: postbird fails at time 102
    tick(102)    # Third attempt: mailfast fails for the second time at 104
    tick(106)

    provider = test_db.execute(
        "SELECT * FROM providers WHERE name = 'mailfast'"
    ).fetchone()

    assert provider["consecutive_failures"] == 2
    assert provider["open_until"] == 136    # Retry at time 112 while mailfast is cooling down

    tick(114)

    latest_attempt = test_db.execute(
        """
        SELECT provider, result
        FROM attempts
        WHERE message_id = ?
        ORDER BY attempt_no DESC
        LIMIT 1
        """,
        (message_id,)
    ).fetchone()

    assert latest_attempt["provider"] == "postbird"

    # mailfast must still be in cooldown
    provider = test_db.execute(
        "SELECT * FROM providers WHERE name = 'mailfast'"
    ).fetchone()

    assert provider["open_until"] == 136

def test_message_deferred_when_all_providers_are_cooling(test_db):

    # Put both email providers into cooldown
    test_db.execute(
        """
        UPDATE providers
        SET consecutive_failures = 2,
            open_until = 150
        WHERE name = 'mailfast'
        """
    )

    test_db.execute(
        """
        UPDATE providers
        SET consecutive_failures = 2,
            open_until = 170
        WHERE name = 'postbird'
        """
    )

    test_db.commit()

    # Create a new email message
    cursor = test_db.execute(
        """
        INSERT INTO messages
        (channel, category, recipient, subject, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            "email",
            "transactional",
            "cooldown@example.com",
            "Cooldown test",
            "Testing provider availability",
            100
        )
    )

    message_id = cursor.lastrowid
    test_db.commit()

        # Run the worker at time 120
    processed = tick(120)

    assert processed == 1

    # Fetch the updated message
    message = test_db.execute(
        "SELECT * FROM messages WHERE id = ?",
        (message_id,)
    ).fetchone()

    assert message["status"] == "pending"
    assert message["attempts"] == 0
    assert message["next_attempt_at"] == 150
    assert message["locked_at"] is None

    attempts = test_db.execute(
        """
        SELECT * FROM attempts
        WHERE message_id = ?
        """,
        (message_id,)
    ).fetchall()

    assert len(attempts) == 0

def test_permanent_failure(test_db):

    # Create a message with an invalid recipient
    cursor = test_db.execute(
        """
        INSERT INTO messages
        (channel, category, recipient, subject, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            "email",
            "transactional",
            "customer@bounce.example",
            "Permanent failure test",
            "Testing invalid recipient",
            100
        )
    )

    message_id = cursor.lastrowid
    test_db.commit()

        # Process the message
    processed = tick(100)

    assert processed == 1

    # Fetch the updated message
    message = test_db.execute(
        "SELECT * FROM messages WHERE id = ?",
        (message_id,)
    ).fetchone()

    assert message["status"] == "failed"
    assert message["attempts"] == 1
    assert message["next_attempt_at"] is None
    assert message["last_error"] == "bounced: recipient does not exist"

        # Verify the permanent failure was recorded
    attempt = test_db.execute(
        """
        SELECT * FROM attempts
        WHERE message_id = ?
        """,
        (message_id,)
    ).fetchone()

    assert attempt is not None
    assert attempt["attempt_no"] == 1
    assert attempt["result"] == "permanent"
    assert attempt["error"] == "bounced: recipient does not exist"

    inbox = test_db.execute(
        """
        SELECT * FROM inbox
        WHERE message_id = ?
        """,
        (message_id,)
    ).fetchall()

    assert len(inbox) == 0

def test_recover_stuck_messages(test_db):

    # Create a message that was interrupted during processing
    cursor = test_db.execute(
        """
        INSERT INTO messages
        (channel, category, recipient, subject, body, status, attempts, locked_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "email",
            "transactional",
            "customer@example.com",
            "Crash recovery test",
            "Testing recovery after a crash",
            "sending",
            1,
            100,
            90
        )
    )

    message_id = cursor.lastrowid
    test_db.commit()

    recovered_count = recover_stuck_messages(test_db)

    assert recovered_count == 1

    message = test_db.execute(
        "SELECT * FROM messages WHERE id = ?",
        (message_id,)
    ).fetchone()

    assert message["status"] == "pending"
    assert message["locked_at"] is None
    assert message["attempts"] == 1

    attempts = test_db.execute(
        """
        SELECT * FROM attempts
        WHERE message_id = ?
        """,
        (message_id,)
    ).fetchall()

    assert len(attempts) == 0

def test_worker_releases_remaining_messages_after_error(test_db, monkeypatch):

    # Create three messages waiting for delivery
    for number in range(1, 4):
        test_db.execute(
            """
            INSERT INTO messages
            (channel, category, recipient, subject, body, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "email",
                "transactional",
                f"customer{number}@example.com",
                f"Test message {number}",
                "Testing batch interruption",
                90 + number
            )
        )

    test_db.commit()

    call_count = 0

    def fake_process_message(connection, message, provider_states, now):
        nonlocal call_count
        call_count += 1

        if call_count == 1:
            connection.execute(
                """
                UPDATE messages
                SET status = 'sent',
                    locked_at = NULL
                WHERE id = ?
                """,
                (message["id"],)
            )
            connection.commit()

        else:
            raise RuntimeError("Simulated worker failure")

    monkeypatch.setattr(worker, "process_message", fake_process_message)

    with pytest.raises(RuntimeError, match="Simulated worker failure"):
        worker.tick(100)

    messages = test_db.execute(
        """
        SELECT id, status, locked_at
        FROM messages
        ORDER BY id
        """
    ).fetchall()

    # First message completed
    assert messages[0]["status"] == "sent"

    # Failed and unprocessed messages were released
    assert messages[1]["status"] == "pending"
    assert messages[2]["status"] == "pending"

    assert messages[1]["locked_at"] is None
    assert messages[2]["locked_at"] is None