# CME provider link repair — September 20, 2026

## Cause and change

The app's monthly provider check sent browser `HEAD` requests with `mode: "no-cors"` to all 38 external providers. Its production Content Security Policy excludes these external hosts from `connect-src`, so blocked requests were recorded as unreachable and generated a misleading “CME provider link(s) may be down” notification. The results were saved for a month and displayed as warning dots in Find CME.

The inverse claim was also unsound: a fulfilled opaque no-CORS response does not expose the HTTP status and cannot prove a successful page response. A network error, a security-policy block, a login requirement and a provider outage are different conditions. [MDN: Fetch responses](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch), [MDN: connect-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src).

The repair removes the invalid background checker, its availability notifications and the provider status claims. Existing saved settings remain compatible but no longer influence provider presentation. Direct Visit links, search, topic filtering and credential deadline reminders remain available. The production security policy is unchanged. This is not a replacement external monitoring service and does not claim continuous availability.

## Confirmed stale destinations

Public GET checks on September 20, 2026 found three HTTP 404 destinations and one obsolete hostname. These four entries now point to current official education pages. All four replacement URLs returned HTTP 200 in public GET checks; the pages' purpose was also reviewed using official source content.

| Entry | Previous destination / observed result | Current official destination |
| --- | --- | --- |
| AANS | `/en/Online-Learning` / 404 | [Education & Publications, including NeuroU](https://www.aans.org/education-publications/) |
| CNS SANS | `/education/sans` / 404 | [SANS Lifelong Learning](https://www.cns.org/education/sans-lifelong-learning) |
| AOA | `education.osteopathic.org` / DNS failure | [AOA Learning Portal](https://elearning.osteopathic.org/), linked by the [AOA CME page](https://osteopathic.org/cme/) |
| CDC HIV | `/hivnexus/hcp/cme/index.html` / 404 | [Provider Resources: HIV trainings and continuing medical education](https://www.cdc.gov/high-quality-care/hcp/resources/provider.html) |

The CDC entry is described as a directory of linked training and continuing education. Activity credit, eligibility, pricing and availability must be confirmed on each activity's current page.

## Validation limits

The original 38-link public GET sweep yielded 23 HTTP 200 responses, ten HTTP 403 responses, three HTTP 404 responses, one DNS failure and one Medscape sign-in redirect limit. Automated-request refusals and sign-in redirects are not evidence of an outage. AMA Ed Hub, for example, supplied readable current education content through the web reader despite refusing the automated GET. The remaining sites have not all been verified through a logged-in browser, and no claim is made that all courses or accreditation terms were audited.

`scripts/cme-link-status.test.mjs` renders the actual provider component with legacy failed, timed-out, successful, missing and malformed results. It also runs the actual notification hook's load, visibility and periodic callbacks with simulated fetch failure, checking that no CME probes or false alerts occur while an ordinary credential reminder still fires. CME presentation and public content regression suites cover adjacent behavior. No account data, CME records, production settings or production notifications are changed by these tests.
