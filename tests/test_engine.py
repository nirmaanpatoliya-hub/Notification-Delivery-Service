from app.engine import backoff_s

def test_backoff():

    assert(backoff_s(1)) ==2
    assert(backoff_s(2)) == 4
    assert(backoff_s(3)) == 8

from app.engine import ProviderState, choose_provider

def test_primary_provider_selected():
    providers= [
        ProviderState("mailfast","email",1),
        ProviderState("postbird","email",2)
    ]

    selected = choose_provider(
        providers,
        "email",
        now=0
    )

    assert selected.name== "mailfast"

def test_backup_selected_when_primary_avoided():

    providers=[ 
        ProviderState("mailfast","email",1),
        ProviderState("postbird","email",2)
    ]

    selected = choose_provider(
        providers,
        "email",
        avoid="mailfast",
        now=0
    )

    assert selected.name=="postbird"

def test_cooling_provider_is_skipped():
    providers=[ 
        ProviderState("mailfast","email",1,2,30),
        ProviderState("postbird","email",2)]
    
    selected = choose_provider(
        providers,
        "email",
        avoid="mailfast",
        now=10
    )
    assert selected.name=="postbird"

def test_no_provider_available():

    providers=[ 
        ProviderState("mailfast","email",1,2,30),
        ProviderState("postbird","email",2,2,40)]

    selected = choose_provider(
        providers,
        "email",
        avoid="mailfast",
        now=10)

    assert selected is None

from app.engine import record_provider_result


def test_circuit_opens_after_two_failures():

    mailfast = ProviderState("mailfast", "email", 1)

    record_provider_result(mailfast, "temporary", 10)

    assert mailfast.consecutive_failures == 1
    assert mailfast.open_until == 0

    record_provider_result(mailfast, "temporary", 10)

    assert mailfast.consecutive_failures == 2
    assert mailfast.open_until == 40


def test_success_resets_failure_count():

    mailfast = ProviderState(
        "mailfast", "email", 1,
        consecutive_failures=1
    )

    record_provider_result(mailfast, "sent", 10)

    assert mailfast.consecutive_failures == 0


def test_bounce_resets_failure_count():

    mailfast = ProviderState(
        "mailfast", "email", 1,
        consecutive_failures=1
    )

    record_provider_result(mailfast, "permanent", 10)

    assert mailfast.consecutive_failures == 0

from app.engine import next_state


def test_successful_delivery():

    result = next_state(0, "sent", None, 10)

    assert result["status"] == "sent"
    assert result["attempts"] == 1


def test_temporary_failure():

    result = next_state(0, "temporary", "timeout", 10)

    assert result["status"] == "pending"
    assert result["attempts"] == 1
    assert result["next_attempt_at"] == 12


def test_permanent_failure():

    result = next_state(0, "permanent", "bounced", 10)

    assert result["status"] == "failed"
    assert result["attempts"] == 1


def test_fourth_failed_attempt():

    result = next_state(
        3,
        "temporary",
        "503 provider unavailable",
        30
    )

    assert result["status"] == "failed"
    assert result["attempts"] == 4
    assert result["next_attempt_at"] is None

from app.engine import defer_until_provider_available


def test_message_waits_without_consuming_attempt():

    providers = [
        ProviderState("mailfast", "email", 1, 2, 40),
        ProviderState("postbird", "email", 2, 2, 50)
    ]

    message = {
        "id": 101,
        "status": "pending",
        "attempts": 2
    }

    result = defer_until_provider_available(
        message,
        providers,
        "email",
        20
    )

    assert result["status"] == "pending"
    assert result["attempts"] == 2
    assert result["next_attempt_at"] == 40
