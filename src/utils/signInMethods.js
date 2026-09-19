// This only exposes the optional client interface. Clerk must be configured
// separately; never infer verified login credentials from profile contact data.
export const SMS_SIGN_IN_ENABLED = import.meta.env?.VITE_SMS_SIGN_IN_ENABLED === "true";

export const SIGN_IN_LOCALIZATION = {
  signIn: {
    password: {
      actionLink: SMS_SIGN_IN_ENABLED ? "Use a sign-in code instead" : "Email me a sign-in code instead",
      subtitle: SMS_SIGN_IN_ENABLED
        ? "Enter your password, or choose another sign-in method"
        : "Enter your password, or get a one-time code by email",
    },
    alternativeMethods: {
      title: "Sign in another way", subtitle: "Pick how you want to sign in",
      blockButton__emailCode: "Email a code to {{identifier}}",
      ...(SMS_SIGN_IN_ENABLED ? { blockButton__phoneCode: "Text a code to {{identifier}}" } : {}),
      getHelp: { blockButton__emailSupport: "Email support" },
    },
    emailCode: { title: "Check your email", subtitle: "Enter the code we just sent to {{identifier}}", formTitle: "Sign-in code", resendButton: "Send a new code" },
  },
};

// Keep enrollment in Clerk's verified account UI. These visual restrictions
// avoid adding unrelated controls; they do NOT replace Clerk's permissions.
// Review the existing provider permissions rather than changing unrelated ones.
export const SIGN_IN_PROFILE_OPTIONS = {
  apiKeysProps: { hide: true },
  appearance: { elements: {
    profileSection__danger: { display: "none" },
    profileSection__username: { display: "none" },
  } },
};

export function openSignInMethods(clerk, userId) {
  if (!SMS_SIGN_IN_ENABLED) return;
  if (!userId || clerk.user?.id !== userId) {
    throw new Error("Your sign-in changed. Refresh the page before managing sign-in methods.");
  }
  try { clerk.openUserProfile(SIGN_IN_PROFILE_OPTIONS); }
  catch { throw new Error("Account security could not open. Refresh the page and try again."); }
}
