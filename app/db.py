import sqlite3
import time
from pathlib import Path
import argparse

DB_PATH=Path(__file__).resolve().parent.parent/"data"/"dakghar.db"

def get_connection():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(DB_PATH)
    connection.row_factory= sqlite3.Row
    connection.execute("PRAGMA foreign_keys= ON")

    return connection

def create_messages_table(connection):
    connection.execute("""
        CREATE TABLE IF NOT EXISTS messages(
            id INTEGER PRIMARY KEY,
            channel TEXT NOT NULL,
            category TEXT NOT NULL,
            recipient TEXT NOT NULL,
            subject TEXT,
            body TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending' , 'sending' , 'sent' , 'failed')),
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at REAL,
            created_at REAL NOT NULL,
            sent_at REAL,
            provider TEXT,
            last_failed_provider TEXT,
            last_error TEXT,
            locked_at REAL,
            idempotency_key TEXT UNIQUE
        )
    """)
    connection.execute("""
        CREATE INDEX IF NOT EXISTS idx_messages_status_next_attempt
        ON messages(status, next_attempt_at)
    """)

def create_providers_table(connection):
    connection.execute("""
        CREATE TABLE IF NOT EXISTS providers (
            name TEXT PRIMARY KEY,
            channel TEXT NOT NULL,
            priority INTEGER NOT NULL,
            fail_rate REAL NOT NULL DEFAULT 0.03,
            outage INTEGER NOT NULL DEFAULT 0,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            open_until REAL
        )   
    """)

def create_attempts_table(connection):
    connection.execute("""
        CREATE TABLE IF NOT EXISTS attempts(
            id INTEGER PRIMARY KEY,
            message_id INTEGER NOT NULL,
            attempt_no INTEGER NOT NULL,
            provider TEXT NOT NULL,
            at REAL NOT NULL,
            result TEXT NOT NULL
                CHECK (result IN ('ok' , 'transient' , 'permanent')),
            error TEXT,
            FOREIGN KEY (message_id) REFERENCES messages(id),
            FOREIGN KEY (provider) REFERENCES providers(name)
        )
    """)

def create_inbox_table(connection):
    connection.execute("""
        CREATE TABLE IF NOT EXISTS inbox (
            id INTEGER PRIMARY KEY,
            message_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            recipient TEXT NOT NULL,
            subject TEXT,
            body TEXT NOT NULL,
            delivered_at REAL NOT NULL,
            UNIQUE (provider, message_id),
            FOREIGN KEY (message_id) REFERENCES messages(id),
            FOREIGN KEY (provider)  REFERENCES providers(name)
        )
    """)

def initialize_database():
    connection = get_connection()

    try:
        create_messages_table(connection)
        create_providers_table(connection)
        create_attempts_table(connection)
        create_inbox_table(connection)

        seed_providers(connection)
        seed_messages(connection)

        connection.commit()
        
    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()

def seed_providers(connection):
    providers = [
        ("mailfast" , "email" , 1, 0.03),
        ("postbird" , "email" ,2, 0.03),
        ("smsly", "sms" ,1 , 0.03),
        ("textgo", "sms" , 2, 0.03)
    ]

    connection.executemany("""
        INSERT OR IGNORE INTO providers
        (name, channel, priority, fail_rate)
        VALUES (?, ?, ?, ?)
    """,providers)

def seed_messages(connection):
    messages = [
        (
            "email",
            "transactional",
            "ritu@shop.example",
            "Order KK-20931 confirmed",
            "Hi Ritu, your order is confirmed."
        ),
        (
            "sms",
            "transactional",
            "+919812345678",
            None,
            "Your KiranaKart delivery OTP is 482913. Valid for 10 minutes."
        ),
        (
            "email",
            "marketing",
            "neha@shop.example",
            "Diwali sale: 20% off sweets",
            "The Diwali sale starts today."
        ),
        (
            "email",
            "transactional",
            "asha@bounce.example",
            "Order KK-20932 confirmed",
            "Bounce demo: no such mailbox."
        ),
        (
            "sms",
            "marketing",
            "+919800000123",
            None,
            "Fresh mangoes are back! Order today on DakGhar."
        )
    ]
    current_time= time.time()

    existing_messages= connection.execute(
        "SELECT COUNT(*) FROM messages"
    ).fetchone()[0]

    if existing_messages>0:
        return

    connection.executemany("""
        INSERT INTO messages
        (channel, category, recipient, subject, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, [
        (*message , current_time) for message in messages
    ])

def reset_database():
    connection = get_connection()

    try:
        connection.execute("DELETE FROM attempts")
        connection.execute("DELETE FROM inbox")
        connection.execute("DELETE FROM messages")
        connection.execute("DELETE FROM providers")

        seed_providers(connection)
        seed_messages(connection)

        connection.commit()

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--reset",
        action="store_true",
        help="Reset the database and reseed sample data"
    )

    args = parser.parse_args()

    if args.reset:
        reset_database()
        print("Database reset successfully!")
    else:
        initialize_database()
        print("Database initialized successfully!")
