import { useEffect, useRef, useState } from "react";
import { useSignIn } from "@clerk/clerk-react";
import { PAY_FIRST_COPY, PAY_FIRST_RETURN_DELAYS_MS, afterSignupReturn, forgetNonce, keptNonce, signInWithTicket, signupStatus, withoutSigninLink } from "../../utils/payFirstSignup.js";

/**
 * Back from a pay-first Checkout (/app/?signup=cs_...), signed out. Asks
 * public-signup-status (which also finishes the account if no webhook did)
 * and signs in with the one-use ticket it returns to this browser. About a
 * minute on, or on any answer that needs the email code, it offers Log in:
 * the account exists with the email paid with, so the code works.
 */
export default function PayFirstReturn({ sessionId, linkTicket, supabaseUrl, onLogIn, T }) {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [phase, setPhase] = useState("setting_up");
  const done = useRef(false);
  useEffect(() => {
    if (!isLoaded || done.current) return undefined;
    // An emailed sign-in link (off until the owner approves its words): its
    // token is the ticket; the address loses it either way (single use).
    if (linkTicket) {
      done.current = true;
      signInWithTicket({ signIn, setActive, ticket: linkTicket }).then(ok => {
        try { history.replaceState(history.state, "", withoutSigninLink(window.location)); } catch { /* Stays as is. */ }
        if (!ok) setPhase("login");
      });
      return undefined;
    }
    let alive = true, step = 0, timer;
    const nonce = keptNonce();
    const ask = async () => {
      if (!alive) return;
      const answer = await signupStatus({ supabaseUrl, sessionId, nonce });
      if (!alive) return;
      if (answer.state === "ready") {
        done.current = true;
        if (await signInWithTicket({ signIn, setActive, ticket: answer.ticket })) {
          forgetNonce();
          // The existing notice confirms the membership once it shows (billingReturn.js).
          try { history.replaceState(history.state, "", afterSignupReturn(window.location)); } catch { /* Stays as is. */ }
          return;
        }
        setPhase("login");
        return;
      }
      if (["login", "already_member"].includes(answer.state)) { done.current = true; setPhase(answer.state); return; }
      step += 1;
      if (step >= PAY_FIRST_RETURN_DELAYS_MS.length) { setPhase("still"); step = PAY_FIRST_RETURN_DELAYS_MS.length - 1; }
      timer = setTimeout(ask, PAY_FIRST_RETURN_DELAYS_MS[step]);
    };
    timer = setTimeout(ask, PAY_FIRST_RETURN_DELAYS_MS[0]);
    return () => { alive = false; clearTimeout(timer); };
  }, [isLoaded, signIn, setActive, sessionId, linkTicket, supabaseUrl]);

  const line = phase === "setting_up" ? PAY_FIRST_COPY.settingUp
    : phase === "already_member" ? PAY_FIRST_COPY.alreadyHaveMembership
      : phase === "login" ? PAY_FIRST_COPY.logInWithCheckoutEmail : PAY_FIRST_COPY.stillSettingUp;
  return (
    <div data-pay-first-return={phase} role="status" aria-live="polite" style={{
      margin: "0 0 14px", padding: "16px 14px", borderRadius: 12, textAlign: "center",
      border: `1px solid ${T.border}`, backgroundColor: T.card,
    }}>
      {phase === "setting_up" && <div className="cmd-spinner" aria-hidden="true" style={{ margin: "0 auto 10px", width: 24, height: 24, borderRadius: "50%", border: `3px solid ${T.border}`, borderTopColor: T.accent, animation: "spin 0.9s linear infinite" }} />}
      <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: T.text, lineHeight: 1.5 }}>{line}</p>
      {phase !== "setting_up" && (
        <button type="button" data-pay-first-login="" onClick={onLogIn} style={{ marginTop: 12, minHeight: 44, padding: "10px 20px", borderRadius: 10, border: "none", background: T.accent, color: "#fff", fontWeight: 700, fontSize: 15, fontFamily: "inherit", cursor: "pointer" }}>
          {PAY_FIRST_COPY.logIn}
        </button>
      )}
    </div>
  );
}
