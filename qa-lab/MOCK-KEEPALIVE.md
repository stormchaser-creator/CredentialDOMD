# Local provider connection lifetime

The mock server keeps idle HTTP connections for ten minutes, with a headers timeout one second longer. This is QA infrastructure only; no production provider client, account access rule or retry policy changes.

The approach was identified in Claude's uncommitted `qa-lab/mocks/server.mjs` change reviewed on 2026-10-01. An independent disposable comparison using the same Supabase Edge Runtime v1.74.2 reproduced a Deno pooled-request error with Node's default five-second timeout plus its one-second buffer: 9 of 10 requests reached the server, and one failed with `connection closed before message completed`. The ten-minute comparison completed all ten requests on one socket. Pauses ranged from 5.98 to 6.02 seconds; no failed request was replayed.

This establishes the short idle-boundary failure and a bounded mitigation. It does not establish the cause of the original full3 Drew Docs390 initialization timeout, which took approximately ten seconds in the Docker logs and remains an unexplained historical observation. Do not waive that error or claim that all transport timeouts are resolved. Final combined verification must still report every unexpected client error.

Regular regression:

    node --test tests/qa-lab/mock-keepalive.test.mjs

Actual pooled Deno regression, using the already cached image and its own disposable container:

    QA_MOCK_POOL_DOCKER=1 node --test tests/qa-lab/mock-keepalive.test.mjs

Set `QA_MOCK_POOL_DOCKER=1` on the complete verifier to execute that optional test. It sends three synthetic health requests once each, reuses one connection across two 6.2-second pauses, and never contacts the active lab. No image is downloaded. The regular regression also verifies that `server.close()` promptly closes idle connections despite the longer keep-alive setting.

The ten-minute setting avoids ordinary pauses in these journeys; it is not a guarantee against every possible boundary race or networking failure. Bounded test/process deadlines and health evidence remain necessary.
