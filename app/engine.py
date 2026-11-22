from dataclasses import dataclass

@dataclass
class ProviderState:
    name:str
    channel:str
    priority:int
    consecutive_failures:int=0
    open_until: float= 0.0

    def is_healthy(self,now):
        return now>=self.open_until

def backoff_s(attempt_number):
    if attempt_number<1:
        raise ValueError("Attempt number must be atleast 1")

    return 2 ** attempt_number

def choose_provider(providers,channel,avoid=None, now=0):

    healthy_providers= []

    for provider in providers:

        if provider.channel != channel:
            continue

        if not provider.is_healthy(now):
            continue

        healthy_providers.append(provider)

    if not healthy_providers:
        return None

    healthy_providers.sort(key=lambda p : p.priority)

    preffered=[]

    for provider in healthy_providers:

        if provider.name != avoid:
            preffered.append(provider)

    if preffered:
        return preffered[0]

    return healthy_providers[0]

providers=[
    ProviderState("mailfast","email",1),
    ProviderState("postbird","email",2),
    ProviderState("smsly","sms",1),
    ProviderState("textgo","sms",2)
]

## Test 1:
# p= choose_provider(
#     providers,
#     "email",
#     now=0)

# print(p.name)

## Test 2: mailfast failed previously
# p = choose_provider(
#     providers,
#     "email",
#     avoid="mailfast",
#     now=0
# )

# print(p.name)

## Test 3:  mailfast is cooling down
# providers[0].open_until=30

# p= choose_provider(
#     providers,
#     "email",
#     now=10
# )

# print(p.name)

## Test 4: Both providers are coooling down:
# providers[0].open_until=30
# providers[1].open_until=40

# p= choose_provider(
#     providers,
#     "email",
#     now=10
# )

# print(p)

## Implementing Circuit Breaker:
CIRCIUIT_FAILURE_LIMIT=2
COOLDOWN_SECONDS=30

def record_provider_result(provider,result,now):
    if result== "temporary":

        provider.consecutive_failures+=1

        if provider.consecutive_failures>= CIRCIUIT_FAILURE_LIMIT:

            provider.open_until= now + COOLDOWN_SECONDS

    elif result in ("sent","permanent"):

        provider.consecutive_failures= 0
        provider.open_until= 0.0

    else:
        raise ValueError("Unknown Provider Result")

## Test 1: testing mailfast, first failure
mailfast = ProviderState("mailfast","email",1)

record_provider_result(mailfast,"temporary",10)

# print(mailfast.consecutive_failures)
# print(mailfast.open_until)

record_provider_result(mailfast,"temporary",10)

# print(mailfast.consecutive_failures)
# print(mailfast.open_until)

## simulating recovey after the cooldown

# print(mailfast.is_healthy(39))
# print(mailfast.is_healthy(40))

MAX_ATTEMPTS = 4
def next_state(attempts,result,error,now):

    attempts+=1

    # Successful Delivery
    if result == "sent":

        return {
            "status": "sent",
            "attempts": attempts,
            "next_attempt_at": None,
            "last_error": None
        }

    # Permanent Failure
    if result == "permanent":

        return  {
            "status": 'failed',
            "attempts":attempts,
            "next_attempt_at": None,
            "last_error": error
        }

    # Temporary Failure
    if result == "temporary":

        if attempts >= MAX_ATTEMPTS:

            return {
                "status":"failed",
                "attempts": attempts,
                "next_attempt_at": None,
                "last_error": (f"Gave up after {MAX_ATTEMPTS} attempts: {error}"
                )
            }

        delay= backoff_s(attempts)

        return {
            "status": "pending",
            "attempts": attempts,
            "next_attempt_at": now + delay,
            "last_error": error
        }
    raise ValueError("Unknown Delivery Result")

## Test 1: Successful Delivery:
# print(next_state(0,"sent","None",10))

## Test 2: Temporary Failure:
# print(next_state(0,"temporary","timeout",10))

## Test 3: Permanent Bounce:
# print(next_state(0,"permanent","bounced",10))

## Test 4: Fourth attempt fails: 
# print(next_state(3,"temporary","503 Provider Unavailable",30))

# When both providers are unavailable:
def earliest_provider_available(providers,channel,now):

    matching= [
        p for p in providers
        if p.channel==channel
    ]

    if not matching:
        return None

    return min(
        max(p.open_until,now)
        for p in matching
    )

def defer_until_provider_available(message, providers , channel, now):

    wake_at= earliest_provider_available(
        providers,
        channel,
        now
    )

    if wake_at is None:
        raise ValueError("No providers configured for this channel")

    updated_message = message.copy()

    updated_message["status"]="pending"
    updated_message["next_attempt_at"]=wake_at

    return updated_message

## Testing:
providers=[
    ProviderState("mailfast","email",1,2,40),
    ProviderState("postbird","email",2,2,50)
]

message={
    "id": 101,
    "status":"pending",
    "attempts":2
}

updated= defer_until_provider_available(
    message,
    providers,
    "email",
    20
)
