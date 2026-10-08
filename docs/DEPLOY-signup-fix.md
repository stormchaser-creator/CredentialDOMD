# Deploy: signup fixes (`fix/signup`)

One ordering step this branch needs that CI cannot do. It holds no production
counts, customer data or secrets.

## The owner notifier ships with the app, not after it

The app now sends the signup funnel's steps to `client_errors` as kind
`info` rows whose message starts `Funnel: ` (`src/utils/funnelEvents.js`).
They are for counting in the table. This branch's `scripts/signup-notify.py`
leaves them out of the owner's alerts.

The notifier does not run from CI or from a worktree. launchd
(`com.credentialdomd.signup-notify`, every 600 s) runs
`/Users/ew/Projects/CredentialDOMD/scripts/signup-notify.sh`, the main
checkout, which only moves when someone fast-forwards it. The notifier there
before this branch turns every `info` row into a `CLIENT EVENT` line. If the
app ships (push to `main`, `deploy-gh-pages.yml`) while that checkout is
behind, each signup that reaches the membership page adds lines such as
`info: Funnel: price shown` to the owner's iMessage until it is fast-forwarded.

Order:

1. Merge and push to `main` as usual.
2. In the same sitting, fast-forward the main checkout:
   `git -C /Users/ew/Projects/CredentialDOMD fetch origin && git -C /Users/ew/Projects/CredentialDOMD merge --ff-only origin/main`
   (it must be on `main` with no local changes; if `--ff-only` refuses, stop
   and look, never reset).
3. Check: `grep -c "Funnel: %" /Users/ew/Projects/CredentialDOMD/scripts/signup-notify.py`
   prints 1 or more. The next run (within 10 minutes) uses it; nothing needs
   reloading.

Undo: none needed. The filter only removes `Funnel: ` info rows from the
alert; the rows stay in `client_errors`.
