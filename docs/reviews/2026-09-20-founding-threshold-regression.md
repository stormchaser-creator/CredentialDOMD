# Founding threshold regression

The earlier 63-check fixture observed zero paid members and then all 100 after a concurrent batch. It did not observe an intermediate paid count, so a premature `paid>=95` transition could survive those tests.

The fixture now settles in batches ending at 95, 96, 99 and 100. At each intermediate boundary it verifies actual paid-place and payment-history counts, 100 occupied places, the complete public $99/temporarily-full response, refusal of a new public claim, and the final unpaid protected holder's $99 preview. At 100 it requires the complete $149/available response. Existing concurrency, consent, release and cancellation checks remain.

Validation on September 20, 2026:

```sh
python3 tests/billing/postgres-founding-cap.py
# PASS: 66 checks
python3 tests/billing/postgres-founding-cap.py --mutation paid-gte-95
# Expected exit 1 at: exactly95 paid of100 occupied keeps public99 pending and protected holder99
```

The optional mutation replaces exactly one SQL expression **in memory**. The official migration remains byte-identical at SHA256 `cf0117ba531ca0e17aef8a8939168dd30007f7a3b48b4eefeb4461eb785e8c1d`. No application behavior, policy, provider or production data changed. Both runs use disposable PostgreSQL, synthetic payment proofs and identity-continuity stubs; this is regression evidence, not an external payment test.
