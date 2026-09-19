import { useState } from "react";
import { useClerk, useUser } from "@clerk/clerk-react";
import { SMS_SIGN_IN_ENABLED, openSignInMethods } from "../../utils/signInMethods";

function EnabledSignInMethodsCard({ theme: T }) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, user } = useUser();
  const [error, setError] = useState("");
  if (!isLoaded || !isSignedIn || !user) return null;
  const verifiedPhones = (user.phoneNumbers || []).filter(phone => phone.verification?.status === "verified");
  const signInPhone = verifiedPhones.some(phone => !phone.reservedForSecondFactor);
  const open = () => {
    setError("");
    try { openSignInMethods(clerk, user.id); }
    catch (cause) { setError(cause.message); }
  };
  return <section aria-label="Sign-in methods" style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14 }}>
    <h3 style={{ fontSize: 16, color: T.text, margin: "0 0 8px" }}>Sign-in methods</h3>
    <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6, margin: "0 0 10px" }}>
      {signInPhone
        ? "You have a verified mobile number on this account. You can choose a text-message code when signing in."
        : verifiedPhones.length
          ? "Your verified mobile number is reserved for two-step verification. Keep using your existing sign-in method; manage sign-in methods to review your options."
          : "Add and verify your mobile number to use a text-message code when signing in. Email sign-in stays available."}
      {" "}The contact phone in your physician profile does not enable text-message sign-in.
    </p>
    <button type="button" onClick={open} style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.accent}`, backgroundColor: T.accentDim, color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
      Manage sign-in methods
    </button>
    {error && <p role="alert" style={{ color: T.danger || T.text, fontSize: 13 }}>{error}</p>}
  </section>;
}

export default function SignInMethodsCard(props) {
  return SMS_SIGN_IN_ENABLED ? <EnabledSignInMethodsCard {...props} /> : null;
}
