import argparse
import json
import math
import random
import statistics
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import app.db as db
from app.main import create_message
from app.models import MessageCreate
from app import worker


TOTAL_MESSAGES = 10_000
BAD_ADDRESSES = 95
CRASH_CLAIM_SIZE = 10
OUTAGE_PROVIDERS = ("mailfast", "smsly", "textgo")


def enqueue_messages(seed):
    random.seed(seed)

    accepted = 0

    for index in range(TOTAL_MESSAGES):
        channel = random.choice(("email", "sms"))
        category = (
            "transactional"
            if random.random() < 0.70
            else "marketing"
        )

        is_bounce = index < BAD_ADDRESSES

        if channel == "email":
            recipient = (
                f"bounce-{index}@bounce.example"
                if is_bounce
                else f"user{index:05d}@example.com"
            )
            subject = f"DakGhar simulation message {index}"
        else:
            recipient = (
                f"+91900000{index:04d}"
                if is_bounce
                else f"+9198{random.randint(10000000, 99999999)}"
            )
            subject = None

        message = MessageCreate(
            channel=channel,
            category=category,
            to=recipient,
            subject=subject,
            body=f"Simulation message number {index}.",
            idempotency_key=f"sim-{seed}-{index:05d}"
        )

        # Use the application's existing validation and creation logic.
        create_message(message)
        accepted += 1

    return accepted


def database_snapshot():
    connection = db.get_connection()

    try:
        counts = {
            row["status"]: row["total"]
            for row in connection.execute(
                """
                SELECT status, COUNT(*) AS total
                FROM messages
                GROUP BY status
                """
            ).fetchall()
        }

        providers = {
            row["name"]: {
                "consecutive_failures": row["consecutive_failures"],
                "open_until": row["open_until"] or 0
            }
            for row in connection.execute(
                """
                SELECT name, consecutive_failures, open_until
                FROM providers
                """
            ).fetchall()
        }

        return counts, providers

    finally:
        connection.close()


def calculate_metrics():
    connection = db.get_connection()

    try:
        total_attempts = connection.execute(
            "SELECT COUNT(*) FROM attempts"
        ).fetchone()[0]

        bounced = connection.execute(
            """
            SELECT COUNT(*)
            FROM messages
            WHERE status = 'failed'
              AND last_error LIKE '%bounced%'
            """
        ).fetchone()[0]

        delays = [
            row["sent_at"] - row["created_at"]
            for row in connection.execute(
                """
                SELECT created_at, sent_at
                FROM messages
                WHERE status = 'sent' AND sent_at IS NOT NULL
                """
            ).fetchall()
        ]

        attempt_rows = connection.execute(
            """
            SELECT message_id, attempt_no, provider, result
            FROM attempts
            ORDER BY message_id, attempt_no
            """
        ).fetchall()

        provider_attempts = connection.execute(
            """
            SELECT
                provider,
                COUNT(*) AS total,
                SUM(CASE WHEN result = 'transient' THEN 1 ELSE 0 END)
                    AS transient_failures,
                SUM(CASE WHEN result = 'permanent' THEN 1 ELSE 0 END)
                    AS permanent_failures
            FROM attempts
            GROUP BY provider
            """
        ).fetchall()

        per_message = defaultdict(list)

        for row in attempt_rows:
            per_message[row["message_id"]].append(row)

        max_failed_before_failover = 0

        for attempts in per_message.values():
            current_provider = None
            consecutive_failures = 0

            for attempt in attempts:
                if current_provider is not None:
                    if attempt["provider"] != current_provider:
                        max_failed_before_failover = max(
                            max_failed_before_failover,
                            consecutive_failures
                        )
                        consecutive_failures = 0

                current_provider = attempt["provider"]

                if attempt["result"] == "transient":
                    consecutive_failures += 1
                else:
                    consecutive_failures = 0

        delays.sort()

        def percentile(values, percent):
            if not values:
                return None
            position = max(0, math.ceil(percent * len(values)) - 1)
            return round(values[position], 3)

        return {
            "total_attempts": total_attempts,
            "bounced_failures": bounced,
            "delivery_delay_seconds": {
                "p50": percentile(delays, 0.50),
                "p95": percentile(delays, 0.95),
                "max": round(max(delays), 3) if delays else None
            },
            "max_failed_attempts_before_provider_switch":
                max_failed_before_failover,
            "provider_attempts": [
                dict(row) for row in provider_attempts
            ]
        }

    finally:
        connection.close()


def run_simulation(seed):
    print(f"\nStarting DakGhar simulation — seed {seed}")
    print(f"Enqueuing {TOTAL_MESSAGES:,} messages...")

    with tempfile.TemporaryDirectory(
        prefix=f"dakghar_sim_{seed}_"
    ) as temporary_directory:

        # Redirect all application database connections to a temporary DB.
        db.DB_PATH = Path(temporary_directory) / "simulation.db"

        db.initialize_database()

        connection = db.get_connection()
        try:
            # Remove the five demonstration messages seeded by the app.
            connection.execute("DELETE FROM attempts")
            connection.execute("DELETE FROM inbox")
            connection.execute("DELETE FROM messages")

            connection.execute(
                """
                UPDATE providers
                SET outage = 0,
                    fail_rate = 0.03,
                    consecutive_failures = 0,
                    open_until = NULL
                """
            )
            connection.commit()
        finally:
            connection.close()

        accepted = enqueue_messages(seed)
        print(f"Accepted: {accepted:,}")

        # Activate three provider outages.
        connection = db.get_connection()
        try:
            connection.executemany(
                "UPDATE providers SET outage = 1 WHERE name = ?",
                [(name,) for name in OUTAGE_PROVIDERS]
            )
            connection.commit()
        finally:
            connection.close()

        # Simulate a worker crash after claiming messages but before processing.
        simulated_now = time.time() + 1

        connection = db.get_connection()
        try:
            claimed = worker.claim_due_messages(
                connection,
                simulated_now,
                limit=CRASH_CLAIM_SIZE
            )
            recovered = worker.recover_stuck_messages(connection)
        finally:
            connection.close()

        print(
            f"Worker crash simulation: {len(claimed)} claimed, "
            f"{recovered} recovered"
        )

        outages_released = False
        outage_details = {}
        max_ticks = 20_000

        for tick_number in range(max_ticks):
            worker.tick(simulated_now)

            counts, provider_states = database_snapshot()

            terminal = counts.get("sent", 0) + counts.get("failed", 0)

            # Release outages after all three circuits have opened.
            if not outages_released:
                all_circuits_open = all(
                    provider_states[name]["open_until"] > simulated_now
                    for name in OUTAGE_PROVIDERS
                )

                if all_circuits_open:
                    outage_details = {
                        name: provider_states[name]["consecutive_failures"]
                        for name in OUTAGE_PROVIDERS
                    }

                    connection = db.get_connection()
                    try:
                        connection.execute(
                            "UPDATE providers SET outage = 0"
                        )
                        connection.commit()
                    finally:
                        connection.close()

                    simulated_now = max(
                        provider_states[name]["open_until"]
                        for name in OUTAGE_PROVIDERS
                    ) + 0.1

                    outages_released = True
                    print(
                        "Provider outages released after circuits opened: "
                        f"{outage_details}"
                    )

            if terminal == accepted:
                break

            simulated_now += 1

        counts, _ = database_snapshot()

        sent = counts.get("sent", 0)
        failed = counts.get("failed", 0)
        pending = counts.get("pending", 0)
        sending = counts.get("sending", 0)

        reconciled = sent + failed + pending + sending
        silent_drops = accepted - reconciled

        metrics = calculate_metrics()

        passed = (
            accepted == TOTAL_MESSAGES
            and pending == 0
            and sending == 0
            and silent_drops == 0
            and recovered == len(claimed)
            and outages_released
            and metrics["bounced_failures"] == BAD_ADDRESSES
            and metrics["max_failed_attempts_before_provider_switch"] <= 2
        )

        report = {
            "seed": seed,
            "result": "PASS" if passed else "CHECK REQUIRED",
            "total_enqueued": accepted,
            "sent": sent,
            "failed": failed,
            "pending": pending,
            "sending": sending,
            "silent_drops": silent_drops,
            "reconciliation_total": reconciled,
            "worker_crash": {
                "messages_claimed": len(claimed),
                "messages_recovered": recovered
            },
            "provider_outages": {
                "providers": list(OUTAGE_PROVIDERS),
                "circuits_opened": outages_released,
                "consecutive_failures_at_release": outage_details
            },
            **metrics
        }

        output_directory = PROJECT_ROOT / "simulation_results"
        output_directory.mkdir(exist_ok=True)

        output_file = output_directory / f"seed_{seed}.json"
        output_file.write_text(
            json.dumps(report, indent=2),
            encoding="utf-8"
        )

        print("\n========== SIMULATION RESULTS ==========")
        print(f"Result:        {report['result']}")
        print(f"Enqueued:      {accepted:,}")
        print(f"Sent:          {sent:,}")
        print(f"Failed:        {failed:,}")
        print(f"Pending:       {pending:,}")
        print(f"Sending:       {sending:,}")
        print(f"Silent drops:  {silent_drops:,}")
        print(f"Total attempts:{metrics['total_attempts']:,}")
        print(f"Bounced:       {metrics['bounced_failures']:,}")
        print(
            "Max failed attempts before provider switch: "
            f"{metrics['max_failed_attempts_before_provider_switch']}"
        )
        print(f"Delivery delays: {metrics['delivery_delay_seconds']}")
        print(f"Saved report:  {output_file.relative_to(PROJECT_ROOT)}")
        print("========================================\n")

        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Run the DakGhar 10,000-message reliability simulation"
    )
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    result = run_simulation(args.seed)

    if result["result"] != "PASS":
        sys.exit(1)
