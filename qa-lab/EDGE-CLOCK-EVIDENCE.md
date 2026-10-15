# Clock evidence for deliberate negative requests

The browser runner and mock delivery journal use the host clock. Docker logs and
PostgreSQL rows use the local Docker VM clock. These clocks can differ: the
isolated regression observed all four deliberate errors after their host HTTP
completion timestamps. Matching raw Docker errors to a host-time window can
therefore falsely report missing evidence.

`readEdgeClock` inspects the exact selected edge container, requires it to be
running, then reads its UTC nanosecond time by immutable container ID. It keeps
host timestamps around that operation and measures elapsed time and both host
sampling spans with a monotonic clock. The two-second clock deadline is bounded;
malformed values, a replaced container, causal ordering mistakes, detected wall
clock changes, and disjoint measured offset intervals fail closed. Date's
millisecond quantum and measured sampling spans validate the receipts; they do
not widen the Docker log window.

Every deliberate negative request has a clock receipt before the HTTP action and
one after the response body completes. Its log window is exactly those two
Docker timestamps. An absent log can be reread for at most two seconds using the
same immutable bounds and container ID. The HTTP action executes once.
Ambiguous occurrences, unavailable logs, a wrong response, or invalid clock
receipts fail immediately. The actual HTTP observation is retained even when
later evidence matching fails; surprising or incomplete responses remain
unverified diagnostics, never error allowances.

The run itself is bracketed the same way. Docker log collection and timestamped
server client-error rows use that measured server window. The original host
window remains attached to the complete mock Stripe delivery audit and source
run timing. Final reconciliation recomputes each request's exact raw occurrence,
requires the same container/run scope, checks clock consistency across the run,
and rejects duplicate claims or unclaimed errors. No aggregate error waiver or
assumed clock correction is introduced.

## Regressions

```sh
node --experimental-vm-modules --test --test-concurrency=6 tests/qa-lab/edge-clock.test.mjs tests/qa-lab/edge-health-claims.test.mjs
QA_EDGE_CLOCK_DOCKER=1 node --experimental-vm-modules --test --test-concurrency=6 tests/qa-lab/*.test.mjs
```

The opt-in Docker test uses the already-cached `ghcr.io/mlflow/mlflow:v3.4.0`
image solely for Python's HTTP server and GNU date. It creates a unique,
loopback-only, read-only container with no capabilities, no database, no provider
credentials, and a separate temporary instance configuration. It removes that
container and temporary files in `finally`. It exercises all four exact negative
responses, the actual Docker log reader, full-run claim reconciliation, duplicate
ambiguity, and an idle client socket. It does not call any running QA lab.
Set `QA_EDGE_CLOCK_DOCKER=1` for complete local verification; without the flag the
additional Docker proof is explicitly reported as skipped.

This proves local clock-domain handling and strict evidence attribution. It does
not prove real provider delivery or production runtime behavior. The integrated
negative browser journeys must still be rerun on the final frozen source.
