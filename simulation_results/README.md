# DakGhar — Reliability Simulation Results

## 1. Objective

The reliability simulation evaluates the DakGhar notification delivery workflow under a controlled workload of 10,000 messages.

It exercises message processing, provider outages, random failures, invalid recipients, worker interruption, recovery, retries, and provider failover.

The simulation uses the actual application database, message creation logic, worker, and delivery engine. Each run uses an isolated temporary SQLite database so that the project's normal database is not used for simulation data.

## 2. Test Configuration

| Parameter | Configuration |
|---|---|
| Messages per run | 10,000 |
| Invalid recipient addresses | 95 |
| Provider outages | 3 |
| Outage providers | mailfast, smsly, textgo |
| Simulated worker interruption | 1 |
| Messages claimed during interruption | 10 |
| Random seeds | 1, 2, 3, 7, 42 |

The simulation uses fixed random seeds to make the test scenarios reproducible.

## 3. Results Summary

All five simulation runs passed.

| Seed | Enqueued | Sent | Failed | Pending | Sending | Silent drops |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 10,000 | 9,905 | 95 | 0 | 0 | 0 |
| 2 | 10,000 | 9,905 | 95 | 0 | 0 | 0 |
| 3 | 10,000 | 9,905 | 95 | 0 | 0 | 0 |
| 7 | 10,000 | 9,905 | 95 | 0 | 0 | 0 |
| 42 | 10,000 | 9,905 | 95 | 0 | 0 | 0 |
| **Total** | **50,000** | **49,525** | **475** | **0** | **0** | **0** |

These are five separate simulation runs of 10,000 messages each, not 50,000 messages processed in one run.

## 4. Message Reconciliation

For every run:

- Accepted messages: 10,000
- Successfully delivered messages: 9,905
- Permanently failed messages: 95
- Pending messages at completion: 0
- Messages still sending at completion: 0
- Silent drops: 0

The reconciliation formula is:

`Sent + Failed + Pending + Sending = Accepted`

For each completed run:

`9,905 + 95 + 0 + 0 = 10,000`

All accepted messages were accounted for at the end of the simulation.

The 95 failures correspond to deliberately invalid recipient addresses. They were recorded as permanent failures rather than silently discarded.

## 5. Provider Outages and Failover

The simulation introduces outages for:

- mailfast
- smsly
- textgo

The outage checks verify that the affected provider circuits open after the configured consecutive-failure threshold.

The observed consecutive failures at outage release were two for each affected provider.

The simulation also records provider attempts and checks the maximum number of failed attempts before an individual message switches providers.

| Seed | Maximum failed attempts before provider switch |
|---:|---:|
| 1 | 2 |
| 2 | 1 |
| 3 | 2 |
| 7 | 2 |
| 42 | 1 |

All runs remained within the configured maximum of two failed attempts before a provider switch.

The per-message provider-switch metric and the provider-wide circuit-breaker threshold are separate measurements.

## 6. Worker Interruption and Recovery

Each simulation includes a controlled interruption scenario.

Ten messages are claimed by the worker and left in the sending state to represent work interrupted before completion.

The recovery mechanism identifies and recovers these messages so they can return to normal processing.

| Seed | Messages claimed | Messages recovered |
|---:|---:|---:|
| 1 | 10 | 10 |
| 2 | 10 | 10 |
| 3 | 10 | 10 |
| 7 | 10 | 10 |
| 42 | 10 | 10 |

All ten claimed messages were recovered in every run.

## 7. Delivery Delay Measurements

The following measurements are in seconds.

| Seed | p50 | p95 | Maximum |
|---:|---:|---:|---:|
| 1 | 159.332 | 256.731 | 267.149 |
| 2 | 144.338 | 249.833 | 261.117 |
| 3 | 158.325 | 277.889 | 297.314 |
| 7 | 160.384 | 251.880 | 275.146 |
| 42 | 157.331 | 248.891 | 262.307 |

The values represent simulated delivery delays under the test conditions. They should not be interpreted as real-world provider latency or production service-level guarantees.

## 8. Attempt Counts

| Seed | Total delivery attempts | Permanent bounce failures |
|---:|---:|---:|
| 1 | 10,346 | 95 |
| 2 | 10,328 | 95 |
| 3 | 10,329 | 95 |
| 7 | 10,306 | 95 |
| 42 | 10,326 | 95 |

Additional provider-level attempt breakdowns are available in each corresponding JSON report.

## 9. Saved Reports

Each simulation writes a JSON report:

- `seed_1.json`
- `seed_2.json`
- `seed_3.json`
- `seed_7.json`
- `seed_42.json`

Each report contains the seed, final message counts, reconciliation, crash recovery information, provider outage details, attempt metrics, and delivery delay measurements.

## 10. Trade-offs and Observations

The simulation uses a deterministic random seed for reproducibility while still exercising random provider outcomes within each scenario.

The temporary SQLite database keeps simulation runs isolated from normal application data. The test invokes application message-creation logic directly rather than sending 10,000 requests through an external HTTP client. HTTP authentication and API behavior are covered separately by the project's automated tests.

The worker interruption is represented by claiming messages and invoking the recovery mechanism; it is a controlled recovery simulation rather than an actual operating-system process kill.

The provider outage and cooldown behavior are evaluated using simulated time. This allows the reliability scenarios to complete without waiting through real-world cooldown periods.

The mock providers make the simulation repeatable and suitable for demonstrating reliability logic, but the results do not establish the throughput or latency of real email or SMS infrastructure.

## 11. Conclusion

All five 10,000-message simulation runs passed.

Across the five isolated runs, 50,000 messages were accepted, 49,525 were successfully delivered, and 475 invalid-recipient messages were recorded as permanent failures.

There were no pending messages, no messages left in the sending state, and no silent drops at completion.

All simulated worker interruptions were recovered, and provider failover remained within the configured checks.

The results demonstrate the expected reliability behavior of the DakGhar notification delivery workflow under the tested scenarios.
