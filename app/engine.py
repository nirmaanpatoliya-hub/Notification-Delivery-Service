
from dataclasses import dataclass


@dataclass
class ProviderState:
    name: str
    channel: str
    priority: int
    consecutive_failures: int = 0
    open_until: float = 0.0

    def is_healthy(self, now):
        return now >= self.open_until


def backoff_s(attempt_number):
    if attempt_number < 1:
        raise ValueError("Attempt number must be at least 1")

    return 2 ** attempt_number


def choose_provider(providers, channel, avoid=None, now=0):
    healthy_providers = []

    for provider in providers:
        if provider.channel != channel:
            continue

        if not provider.is_healthy(now):
            continue

        healthy_providers.append(provider)

    if not healthy_providers:
        return None

    healthy_providers.sort(key=lambda p: p.priority)

    preferred = []

    for provider in healthy_providers:
        if provider.name != avoid:
            preferred.append(provider)

    if preferred:
        return preferred[0]

    return healthy_providers[0]


CIRCUIT_FAILURE_LIMIT = 2
COOLDOWN_SECONDS = 30


def record_provider_result(provider, result, now):
    if result == "temporary":
        provider.consecutive_failures += 1

        if provider.consecutive_failures >= CIRCUIT_FAILURE_LIMIT:
            provider.open_until = now + COOLDOWN_SECONDS

    elif result in ("sent", "permanent"):
        provider.consecutive_failures = 0
        provider.open_until = 0.0

    else:
        raise ValueError("Unknown Provider Result")


MAX_ATTEMPTS = 4


def next_state(attempts, result, error, now):
    attempts += 1

    # Successful delivery
    if result == "sent":
        return {
            "status": "sent",
            "attempts": attempts,
            "next_attempt_at": None,
            "last_error": None
        }

    # Permanent failure
    if result == "permanent":
        return {
            "status": "failed",
            "attempts": attempts,
            "next_attempt_at": None,
            "last_error": error
        }

    # Temporary failure
    if result == "temporary":
        if attempts >= MAX_ATTEMPTS:
            return {
                "status": "failed",
                "attempts": attempts,
                "next_attempt_at": None,
                "last_error": (
                    f"Gave up after {MAX_ATTEMPTS} attempts: {error}"
                )
            }

        delay = backoff_s(attempts)

        return {
            "status": "pending",
            "attempts": attempts,
            "next_attempt_at": now + delay,
            "last_error": error
        }

    raise ValueError("Unknown Delivery Result")


def earliest_provider_available(providers, channel, now):
    matching = [
        provider
        for provider in providers
        if provider.channel == channel
    ]

    if not matching:
        return None

    return min(
        max(provider.open_until, now)
        for provider in matching
    )


def defer_until_provider_available(message, providers, channel, now):
    wake_at = earliest_provider_available(
        providers,
        channel,
        now
    )

    if wake_at is None:
        raise ValueError("No providers configured for this channel")

    updated_message = message.copy()
    updated_message["status"] = "pending"
    updated_message["next_attempt_at"] = wake_at

    return updated_message
