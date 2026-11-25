# DakGhar — Notification Delivery Service

DakGhar is a notification delivery service that accepts email and SMS messages, stores them in a persistent SQLite queue, processes them through simulated providers, and tracks their delivery status.

The project demonstrates reliable message processing through background workers, retries, provider failover, circuit breakers, authentication, idempotency, and crash recovery.

> **Important:** DakGhar currently uses mock email and SMS providers. It demonstrates the delivery workflow without sending real emails or SMS messages.

---

## 1. Project Objectives

- Accept email and SMS notification requests through a REST API.
- Persist accepted messages in a SQLite database.
- Process queued messages using a background worker.
- Retry messages after temporary provider failures.
- Switch providers when a provider becomes unavailable.
- Prevent repeated processing through idempotency keys.
- Track message attempts, delivery outcomes, and failures.
- Recover messages left in a sending state after worker interruption.
- Provide a web dashboard to operate and monitor the service.

## 2. Technology Stack

| Component | Technology |
|---|---|
| Backend | Python |
| API framework | FastAPI |
| Database | SQLite |
| Data validation | Pydantic |
| Background processing | Python threading |
| Frontend | HTML, CSS, JavaScript |
| Testing | Pytest |
| Application server | Uvicorn |
| Environment configuration | python-dotenv |

## 3. System Architecture

The application consists of five main parts:

1. **Frontend:** Provides screens for sending messages, monitoring the outbox, viewing message details, managing providers and workers, inspecting the fake inbox, and understanding the system.
2. **API layer:** Accepts requests, validates inputs, applies authentication, and exposes message and operational endpoints.
3. **Database layer:** Stores messages, providers, delivery attempts, and successfully delivered messages.
4. **Worker:** Runs in the background and processes due messages from the queue.
5. **Provider and delivery engine:** Simulates provider responses, retries transient failures, handles permanent failures, and manages provider failover.

### Message lifecycle

1. A sender submits an email or SMS request.
2. The API validates the request and stores the message in SQLite.
3. The message enters the `pending` state.
4. The background worker claims due messages.
5. The delivery engine selects an eligible provider.
6. The provider returns a simulated success, transient failure, or permanent failure.
7. Successful messages enter the `sent` state and appear in the fake inbox.
8. Temporary failures can be retried or routed through another provider.
9. Messages that cannot be delivered enter the `failed` state with an error reason.

### Message statuses

| Status | Meaning |
|---|---|
| `pending` | Waiting to be processed or retried |
| `sending` | Currently claimed for processing |
| `sent` | Successfully delivered by a mock provider |
| `failed` | Delivery permanently failed or retry limit reached |

## 4. Project Structure

```text
DakGhar/
├── app/
│   ├── auth.py
│   ├── db.py
│   ├── engine.py
│   ├── main.py
│   ├── models.py
│   ├── providers.py
│   ├── worker.py
│   └── static/
│       ├── css/
│       │   └── styles.css
│       ├── js/
│       │   ├── api.js
│       │   ├── send.js
│       │   ├── outbox.js
│       │   ├── message.js
│       │   ├── providers.js
│       │   └── inbox.js
│       ├── send.html
│       ├── outbox.html
│       ├── message.html
│       ├── providers.html
│       ├── inbox.html
│       └── about.html
├── data/
│   └── dakghar.db
├── docs/
├── scripts/
│   └── simulate_sends.py
├── simulation_results/
│   ├── README.md
│   ├── seed_1.json
│   ├── seed_2.json
│   ├── seed_3.json
│   ├── seed_7.json
│   └── seed_42.json
├── tests/
│   ├── test_api.py
│   ├── test_auth.py
│   ├── test_engine.py
│   └── test_worker.py
├── .env.example
├── .gitignore
├── requirements.txt
└── README.md
```

## 5. Database Design

DakGhar uses SQLite with four main tables.

### messages

Stores submitted notifications and their current delivery state.

Important fields include:
- `id`
- `channel`
- `category`
- `recipient`
- `subject`
- `body`
- `status`
- `attempts`
- `next_attempt_at`
- `created_at`
- `sent_at`
- `provider`
- `last_failed_provider`
- `last_error`
- `locked_at`
- `idempotency_key`

### providers

Stores provider configuration and circuit-breaker state.

Important fields include:
- `name`
- `channel`
- `priority`
- `fail_rate`
- `outage`
- `consecutive_failures`
- `open_until`

### attempts

Records individual delivery attempts, including the provider, attempt number, timestamp, result, and error.

### inbox

Stores successfully delivered mock messages for inspection in the Fake Inbox screen.

## 6. Providers, Retries and Failover

The application uses four simulated providers:

| Provider | Channel |
|---|---|
| mailfast | Email |
| postbird | Email |
| smsly | SMS |
| textgo | SMS |

The delivery engine distinguishes between:

- **Successful delivery:** The provider accepts the message.
- **Transient failure:** A temporary failure that may be retried or handled through failover.
- **Permanent failure:** A failure such as an invalid recipient that should not be retried indefinitely.

The application uses a maximum of four delivery attempts per message.

### Circuit breaker

The circuit breaker monitors consecutive provider failures. After two consecutive failures, the provider circuit opens and that provider is temporarily avoided.

The configured cooldown is 30 seconds. After the cooldown, the provider can become eligible again.

### Idempotency

An optional idempotency key prevents duplicate message creation for requests that are submitted repeatedly with the same key.

The database enforces uniqueness for this key.

## 7. Authentication

The API uses environment-based API keys.

Two keys are configured:

- `SENDER_KEY`: Used for sender-level access.
- `ADMIN_KEY`: Used for administrative access.

### Request headers

Sender-level endpoints use:

`X-Api-Key: YOUR_SENDER_OR_ADMIN_KEY`

Administrative endpoints use:

`X-Admin-Key: YOUR_ADMIN_KEY`

The admin key also grants sender-level access.

The `/health` endpoint is publicly accessible.

Never commit your actual `.env` file or expose API keys in screenshots, source code, or public repositories.

## 8. API Endpoints

| Method | Endpoint | Access |
|---|---|---|
| GET | `/` | Public; redirects to frontend |
| GET | `/health` | Public |
| POST | `/api/messages` | Sender |
| GET | `/api/messages` | Sender |
| GET | `/api/messages/{message_id}` | Sender |
| GET | `/api/providers` | Sender |
| PATCH | `/api/providers/{name}` | Admin |
| GET | `/api/inbox` | Sender |
| GET | `/api/worker` | Sender |
| PATCH | `/api/worker` | Admin |
| POST | `/api/worker/tick` | Admin |
| POST | `/api/admin/reset` | Admin |

For request and response schemas, open the interactive API documentation at `/docs` while the application is running.

## 9. Frontend Screens

The web interface contains six screens:

1. **Send Message:** Submit email and SMS notifications.
2. **Outbox:** Monitor queued messages, delivery statuses, and message filters.
3. **Message Details:** Inspect recipient information, delivery attempts, and message history.
4. **Providers & Worker:** Monitor provider health, circuit breakers, and background worker controls.
5. **Fake Inbox:** View messages successfully delivered by mock providers.
6. **How It Works:** Understand the architecture and message delivery lifecycle.

The frontend communicates with the FastAPI backend through the shared JavaScript API client.

## 10. Installation and Setup

### Prerequisites

- Python 3.9 or later
- Git
- A terminal

### Clone the repository

```bash
git clone https://github.com/nirmaanpatoliya-hub/Notification-Delivery-Service.git

cd Notification-Delivery-Service
```

### Create a virtual environment

```bash
python3 -m venv .venv
```

Activate it:

```bash
source .venv/bin/activate
```

### Install dependencies

```bash
pip install -r requirements.txt
```

### Configure environment variables

Create a local `.env` file:

```bash
cp .env.example .env
```

Replace the placeholder values with your own strong keys.

Do not commit `.env`.

### Start the application

```bash
uvicorn app.main:app --reload
```

Open the application:

- Frontend: http://127.0.0.1:8000/
- API documentation: http://127.0.0.1:8000/docs
- Health check: http://127.0.0.1:8000/health

The application initializes the database, recovers eligible stuck messages, and starts the background worker during application startup.

## 11. Running Tests

Run the complete test suite:

```bash
python -m pytest
```

The project currently has **50 passing tests** covering API behavior, authentication, delivery engine logic, and worker behavior.

## 12. Reliability Simulation

The project includes a 10,000-message reliability simulation.

Run the default simulation:

```bash
python scripts/simulate_sends.py
```

Run with a specific random seed:

```bash
python scripts/simulate_sends.py --seed 1
```

The simulation exercises:

- 10,000 message submissions.
- Three simulated provider outages.
- Random provider failures.
- Invalid recipient addresses.
- Worker interruption and recovery.
- Provider circuit breakers and failover.
- Final message reconciliation.

Five runs have been completed using seeds `1`, `2`, `3`, `7`, and `42`.

Detailed JSON reports and the results analysis are available in `simulation_results/`.

## 13. Limitations and Future Improvements

Current limitations:

- Email and SMS providers are simulated; no real notifications are sent.
- SQLite is used as the database.
- The background worker runs within the application process.
- The system is designed as a single-instance demonstration rather than a distributed production service.
- Production-grade monitoring and external provider integrations are not included.

Possible future improvements:

- Integrate real email and SMS providers.
- Introduce PostgreSQL for larger deployments.
- Use a dedicated distributed task queue.
- Add centralized logging and monitoring.
- Introduce delivery webhooks and reporting.
- Add deployment-grade persistent storage and operational monitoring.

---

## 14. Project Summary

DakGhar demonstrates how a notification delivery service can manage message queues, process notifications asynchronously, recover from worker interruptions, handle provider failures, prevent duplicate submissions, and maintain delivery records.

The project combines a Python FastAPI backend, SQLite persistence, a background worker, simulated providers, and a web-based dashboard to demonstrate the complete notification delivery workflow.
