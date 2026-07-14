import { memo, useEffect, useState } from "react";
import { SignIn, SignUp } from "@clerk/clerk-react";
import { THEMES } from "../../constants/themes";
import { AsclepiusIcon } from "../shared/Icons";

/**
 * Auth landing page — wraps Clerk's hosted <SignIn /> / <SignUp /> components
 * inside the CredentialDOMD shell (logo, brand chrome, footer).
 *
 * Clerk owns email+password, magic links, OAuth, password reset, and account
 * verification, so this file only needs to handle the brand wrapper and the
 * sign-in / sign-up tab toggle.
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

const HIDE_SOCIAL_ELEMENTS = IS_DEV_CLERK_INSTANCE
  ? {
      socialButtons: { display: "none" },
      socialButtonsRoot: { display: "none" },
      socialButtonsBlockButton: { display: "none" },
      socialButtonsIconButton: { display: "none" },
      dividerRow: { display: "none" },
    }
  : {};

function AuthPage() {
  const [mode, setMode] = useState(() =>
    window.location.hash.includes("sign-up") ? "signup" : "signin"
  ); // "signin" | "signup"
  const T = THEMES.light;

  // Clerk's own footer links ("Don't have an account? Sign up" / "Already
  // have an account? Sign in") navigate to #sign-up / #sign-in. The card
  // shown is controlled by our tab state, so mirror those hash changes into
  // it — otherwise the links change the URL but nothing on screen.
  useEffect(() => {
    const onHashChange = () => {
      const h = window.location.hash;
      if (h.includes("sign-up")) {
        setMode("signup");
        // Clear the marker so Clerk's hash router starts clean.
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } else if (h.includes("sign-in")) {
        setMode("signin");
        history.replaceState(null, "", window.location.pathname + window.location.search);
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

        {/* Mode toggle */}
        <div style={{
          display: "flex", gap: 0, marginBottom: 16,
          backgroundColor: T.input, borderRadius: 10, padding: 3,
        }}>
          <button
            onClick={() => setMode("signin")}
            style={{
              flex: 1, padding: "10px 0", fontSize: 14, fontWeight: 700,
              color: mode === "signin" ? T.accent : T.textMuted,
              backgroundColor: mode === "signin" ? T.card : "transparent",
              border: "none", borderRadius: 8, cursor: "pointer",
              transition: "all 0.2s",
              boxShadow: mode === "signin" ? T.shadow1 : "none",
            }}
          >
            Sign In
          </button>
          <button
            onClick={() => setMode("signup")}
            style={{
              flex: 1, padding: "10px 0", fontSize: 14, fontWeight: 700,
              color: mode === "signup" ? T.accent : T.textMuted,
              backgroundColor: mode === "signup" ? T.card : "transparent",
              border: "none", borderRadius: 8, cursor: "pointer",
              transition: "all 0.2s",
              boxShadow: mode === "signup" ? T.shadow1 : "none",
            }}
          >
            Create Account
          </button>
        </div>

        {/* Clerk widget */}
        <div style={{ display: "flex", justifyContent: "center" }}>
          {mode === "signin" ? (
            <SignIn
              routing="hash"
              signUpUrl="#sign-up"
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
                },
                variables: {
                  colorPrimary: "#10b981",
                  colorText: T.text,
                  colorBackground: T.card,
                  borderRadius: "12px",
                },
              }}
            />
          ) : (
            <SignUp
              routing="hash"
              signInUrl="#sign-in"
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
