#!/bin/zsh
# Validate the deployed Clerk key against the actual edge issuer and Supabase trust.
# Any API outage is a failed check, not evidence that configuration is missing.
exec python3 - <<'PYTHON'
import base64, hashlib, json, re, subprocess, sys
import urllib.request, urllib.error
PROJECT = "hkpnnsjcwprrwobmpqyy"

def get(url, token=None, as_json=True):
    headers = {"Authorization": "Bearer " + token} if token else {}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
            raw = response.read().decode()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()
        try:
            body = json.loads(detail)
            message = body.get("error") or body.get("message") or "Request failed"
            estimate = body.get("estimated_completion", "")
        except ValueError:
            message, estimate = "Request failed", ""
        raise RuntimeError(f"HTTP {exc.code}: {message} {estimate}".strip()) from None
    return json.loads(raw) if as_json else raw

def strings(value):
    if isinstance(value, str): yield value
    elif isinstance(value, dict):
        for v in value.values(): yield from strings(v)
    elif isinstance(value, list):
        for v in value: yield from strings(v)

try:
    html = get("https://credentialdomd.com/app/", as_json=False)
    bundle = re.search(r'/app/assets/index-[A-Za-z0-9_-]+\.js', html)
    if not bundle: raise RuntimeError("Could not find the deployed app bundle")
    source = get("https://credentialdomd.com" + bundle.group(), as_json=False)
    keys = set(re.findall(r'pk_(?:test|live)_[A-Za-z0-9_-]{10,}', source))
    if len(keys) != 1: raise RuntimeError("Could not identify one deployed Clerk publishable key")
    key = keys.pop()
    encoded = key.split("_", 2)[2]
    host = base64.b64decode(encoded + "=" * (-len(encoded) % 4)).decode().rstrip("$")
    if host not in {"dynamic-goshawk-87.clerk.accounts.dev", "clerk.credentialdomd.com"}:
        raise RuntimeError("Unexpected Clerk instance; verify its ownership before deployment")
    issuer = "https://" + host
    token = subprocess.check_output(["security", "find-generic-password", "-l", "Supabase CLI", "-w"], stderr=subprocess.DEVNULL).decode().strip()
    secrets = get(f"https://api.supabase.com/v1/projects/{PROJECT}/secrets", token)
    if not isinstance(secrets, list): raise RuntimeError("Unexpected secrets response")
    digest = next((s.get("value") for s in secrets if s.get("name") == "CLERK_ISSUER"), None)
    if digest is None: raise RuntimeError("CLERK_ISSUER is missing; set it to match the deployed publishable key")
    if digest != hashlib.sha256(issuer.encode()).hexdigest():
        raise RuntimeError("CLERK_ISSUER does not match the deployed publishable key")
    trust = get(f"https://api.supabase.com/v1/projects/{PROJECT}/config/auth/third-party-auth", token)
    if not any(s.rstrip("/") in {issuer, host} for s in strings(trust)):
        raise RuntimeError("Supabase does not list the deployed Clerk issuer")
    jwks = get(issuer + "/.well-known/jwks.json")
    if not jwks.get("keys"): raise RuntimeError("Clerk returned no signing keys")
    print(f"PASS: deployed app, edge functions, and Supabase agree on {host}; signing keys are available.")
except Exception as exc:
    print(f"BLOCKED: {exc}. No deployment was performed.", file=sys.stderr)
    sys.exit(1)
PYTHON
