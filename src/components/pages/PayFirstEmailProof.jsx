import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { PAY_FIRST_SIGNUP_ENABLED, proveEmailOnce } from "../../utils/payFirstSignup.js";

/**
 * Signed in: once per session, lets the server turn docs@ on for an account
 * made from a Checkout email, when this is not the instant sign-in (the
 * server decides; any other account answers at once). Renders nothing, and
 * does nothing while pay-first sign-up is off.
 */
export default function PayFirstEmailProof() {
  const { isSignedIn, sessionId, getToken } = useAuth();
  useEffect(() => {
    if (!PAY_FIRST_SIGNUP_ENABLED || !isSignedIn || !sessionId) return;
    proveEmailOnce({ supabaseUrl: import.meta.env?.VITE_SUPABASE_URL, sessionId, getToken: () => getToken() });
  }, [isSignedIn, sessionId, getToken]);
  return null;
}
