import { useState } from "react";
import { useClerk, useUser } from "@clerk/clerk-react";
import { SMS_SIGN_IN_ENABLED, openAccountSecurity } from "../../utils/signInMethods";

// Password and sign-in email for every signed-in member (AUTH-012). The
// text-message paragraph appears only when SMS sign-in is switched on.
export default function SignInMethodsCard({ theme: T }) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, user } = useUser();
  const [error, setError] = useState("");
  if (!isLoaded || !isSignedIn || !user) return null;
  const verifiedPhones = (user.phoneNumbers || []).filter(phone => phone.verification?.status === "verified");
  const signInPhone = verifiedPhones.some(phone => !phone.reservedForSecondFactor);
  const open = () => {
    setError("");
    try { openAccountSecurity(clerk, user.id); }
    catch (cause) { setError(cause.message); }
  };
  const paragraph = { fontSize: 13, color: T.textMuted, lineHeight: 1.6, margin: "0 0 10px" };
  return <section aria-label={SMS_SIGN_IN_ENABLED ? "Sign-in methods" : "Password and sign-in email"} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14 }}>
    <h3 style={{ fontSize: 16, color: T.text, margin: "0 0 8px" }}>{SMS_SIGN_IN_ENABLED ? "Sign-in methods" : "Password and sign-in email"}</h3>
    {SMS_SIGN_IN_ENABLED && <p style={paragraph}>
      {signInPhone
        ? "You have a verified mobile number on this account. You can choose a text-message code when signing in."
        : verifiedPhones.length
          ? "Your verified mobile number is reserved for two-step verification. Keep using your existing sign-in method; manage sign-in methods to review your options."
          : "Add and verify your mobile number to use a text-message code when signing in. Email sign-in stays available."}
      {" "}The contact phone in your physician profile does not enable text-message sign-in.
    </p>}
    <p style={paragraph}>
      Change your password or the email you sign in with here. For a new sign-in email: add the address, enter the code sent to it, make it primary, then remove the old one.
      {" "}The Email field in your profile below is a contact address and does not change how you sign in.
    </p>
    <button type="button" onClick={open} style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.accent}`, backgroundColor: T.accentDim, color: T.accent, fontSize: 16, fontWeight: 700, cursor: "pointer" }}>
      {SMS_SIGN_IN_ENABLED ? "Manage sign-in methods" : "Change password or sign-in email"}
    </button>
    {error && <p role="alert" style={{ color: T.danger || T.text, fontSize: 13 }}>{error}</p>}
  </section>;
}
