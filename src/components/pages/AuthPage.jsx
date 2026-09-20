import { memo, useEffect, useRef, useState } from "react";
import { SignIn } from "@clerk/clerk-react";
import { THEMES } from "../../constants/themes";
import { AsclepiusIcon } from "../shared/Icons";
import { SMS_SIGN_IN_ENABLED } from "../../utils/signInMethods";

/**
 * Auth landing page — wraps Clerk's unified <SignIn withSignUp /> component
 * inside the CredentialDOMD shell (logo, brand chrome, footer).
 *
 * Clerk owns email+password, magic links, OAuth, password reset, and account
 * verification. This file provides the brand wrapper and maps old entry links
 * to the same flow without rewriting Clerk verification routes.
 *
 * Routing: the app is served at /app/ on gh-pages and has no React Router,
 * so we use Clerk's `routing="hash"` mode which keeps everything inside the
 * URL hash (#/factor-one, #/verify-email, etc.) instead of mutating paths.
 */
// Social (Google) sign-in only works on a *production* Clerk instance.
// On a dev instance (pk_test_…), OAuth routes through Clerk's shared proxy at
// clerk.shared.lcl.dev, which cannot hand a session back to credentialdomd.com —
// the user authenticates on Google's side but never gets signed in here.
// Gate on the key type so the button hides itself on dev keys and reappears
// automatically once the pk_live_ key ships. Cutover steps: PRODUCTION-CUTOVER.md.
const IS_DEV_CLERK_INSTANCE =
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "").startsWith("pk_test_");
// Only these old app-owned markers are aliases. Provider routes such as
// #/verify-email and #/factor-one belong to Clerk and must stay untouched.
const isLegacyEntry = hash => hash === "#sign-in" || hash === "#sign-up";

const HIDE_SOCIAL_ELEMENTS = IS_DEV_CLERK_INSTANCE
  ? {
      socialButtons: { display: "none" },
      socialButtonsRoot: { display: "none" },
      socialButtonsBlockButton: { display: "none" },
      socialButtonsIconButton: { display: "none" },
      dividerRow: { display: "none" },
    }
  : {};

// Clerk's prebuilt sign-in turns "Email me a sign-in code instead" into a
// two-step trip: the link opens a "Sign in another way" list, and the code is
// only sent after a second tap on "Email a code to ...". Physicians expect
// one tap. So: when that link is tapped, arm a short window; when the list
// renders inside it, press the email-code option for them. The list is
// still reachable the normal way (a tap that did not come from that link
// leaves it alone), so nothing is lost if Clerk adds other methods.
const CODE_LINK_TEXT = "Email me a sign-in code instead";
const CODE_OPTION_PREFIX = "Email a code to";
function useOneTapEmailCode(containerRef, enabled) {
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !enabled) return undefined;
    let armedUntil = 0;
    const onClick = (e) => {
      const el = e.target instanceof Element ? e.target.closest("button, a") : null;
      if (el && (el.textContent || "").trim() === CODE_LINK_TEXT) armedUntil = Date.now() + 4000;
    };
    const tryAdvance = () => {
      if (Date.now() > armedUntil) return;
      const btn = Array.from(root.querySelectorAll("button")).find(b => (b.textContent || "").trim().startsWith(CODE_OPTION_PREFIX));
      if (btn) { armedUntil = 0; btn.click(); }
    };
    const mo = new MutationObserver(tryAdvance);
    mo.observe(root, { childList: true, subtree: true });
    root.addEventListener("click", onClick, true);
    return () => { mo.disconnect(); root.removeEventListener("click", onClick, true); };
  }, [containerRef, enabled]);
}

function AuthPage() {
  // Delay the widget for an old app-owned marker until it is normalized, so
  // Clerk never mounts on an unsupported route. Normal provider steps mount as-is.
  const [entry, setEntry] = useState(() => ({ ready: !isLegacyEntry(window.location.hash), version: 0 }));
  const widgetRef = useRef(null);
  useOneTapEmailCode(widgetRef, entry.ready && !SMS_SIGN_IN_ENABLED);
  const T = THEMES.light;

  useEffect(() => {
    const onHashChange = () => {
      if (isLegacyEntry(window.location.hash)) {
        history.replaceState(history.state, "", window.location.pathname + window.location.search);
        // replaceState emits no hashchange. A fresh widget deterministically
        // resets Clerk even if its router observed the old entry marker first.
        setEntry(previous => ({ ready: true, version: previous.version + 1 }));
      } else {
        setEntry(previous => previous.ready ? previous : { ...previous, ready: true });
      }
    };
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div style={{
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      backgroundColor: T.bg,
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px 20px",
    }}>
      <div className="cmd-fade-in" style={{ width: "100%", maxWidth: 440 }}>
        {/* Logo + App Name */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 20,
            background: "linear-gradient(135deg, #10b981, #059669)",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 16px",
            boxShadow: "0 8px 24px rgba(16,185,129,0.25)",
          }}>
            <AsclepiusIcon size={34} color="#FFFFFF" />
          </div>
          <h1 style={{
            fontSize: 24, fontWeight: 800, color: T.text,
            margin: "0 0 4px", letterSpacing: "-0.02em",
          }}>
            Credential<span style={{ color: T.accent }}>DOMD</span>
          </h1>
          <p style={{ fontSize: 14, color: T.textMuted, margin: 0, fontWeight: 500 }}>
            Physician Credential Management
          </p>
        </div>

        <p style={{ margin: "0 0 16px", color: T.textMuted, fontSize: 13, lineHeight: 1.6, textAlign: "center" }}>
          Already have an account? Use the same email address.
        </p>

        {/* Clerk widget */}
        <div ref={widgetRef} style={{ display: "flex", justifyContent: "center" }}>
          {entry.ready && (
            <SignIn
              key={entry.version}
              routing="hash"
              withSignUp
              signUpFallbackRedirectUrl="/app/"
              fallbackRedirectUrl="/app/"
              appearance={{
                elements: {
                  rootBox: { width: "100%" },
                  ...HIDE_SOCIAL_ELEMENTS,
                  card: {
                    backgroundColor: T.card,
                    border: `1px solid ${T.border}`,
                    boxShadow: T.shadow2,
                    borderRadius: 16,
                  },
                  // Keep the alternate sign-in method easy to find.
                  alternativeMethodsBlockButton: { width: "100%", justifyContent: "center", padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.accent}`, fontWeight: 700 },
                  footerActionLink: { fontWeight: 700 },
                },
                variables: {
                  colorPrimary: "#10b981",
                  colorText: T.text,
                  colorBackground: T.card,
                  borderRadius: "12px",
                },
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div style={{
          textAlign: "center", marginTop: 24,
          fontSize: 12, color: T.textDim, lineHeight: 1.5,
        }}>
          Your data is encrypted and stored securely.
          <br />
          CredentialDOMD v2.3
        </div>
      </div>
    </div>
  );
}

export default memo(AuthPage);
