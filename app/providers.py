import random
import time

from app.db import get_connection

class MockProvider:

    def __init__(self,name):
        self.name = name

    def _load_config(self,connection):
        row = connection.execute(
            """
            SELECT name, channel, priority, fail_rate, outage
            FROM providers
            WHERE name = ?
            """,
            (self.name,)
        ).fetchone()

        if row is None:
            raise ValueError(f"Unknown Provider: {self.name}")

        return row

    def send(self,message):
        connection = get_connection()

        try:
            config = self._load_config(connection)

            recipient = message["recipient"]

            if config["outage"] == 1:
                return "transient", "503 provider unavailable"

            if  (
                recipient.endswith("@bounce.example")
                or recipient.startswith("+91900000")
            ):
                return "permanent", "bounced: recipient does not exist"

            if random.random() < config["fail_rate"]:
                return "transient", "timeout after 2 s"

            connection.execute(
                """
                INSERT OR IGNORE INTO inbox
                (message_id, provider, recipient, subject, body, delivered_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    message["id"],
                    self.name,
                    recipient,
                    message.get("subject"),
                    message["body"],
                    time.time()
                )
            )

            connection.commit()

            print(
                f"[{self.name}] Delivered notification to {recipient}"
            )

            return "ok", None
        
        finally:
            connection.close()

mailfast = MockProvider("mailfast")
postbird = MockProvider("postbird")
smsly = MockProvider("smsly")
textgo = MockProvider("textgo")

PROVIDERS = [
    mailfast,
    postbird,
    smsly,
    textgo
]