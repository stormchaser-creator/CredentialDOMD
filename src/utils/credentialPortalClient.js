export const CREDENTIAL_PORTAL_ENABLED = import.meta.env.VITE_CREDENTIAL_PORTAL_ENABLED === "true";

// Direct Clerk session token: the endpoint verifies Clerk's issuer/signature
// and resolves ownership from its subject, without trusting editable email.
export async function credentialPortalRequest(body, { signal } = {}) {
  if (!CREDENTIAL_PORTAL_ENABLED) throw new Error("Private credential access is not available yet.");
  const token = await window.Clerk?.session?.getToken();
  if (!token) throw new Error("Sign in again to manage private access.");
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/credential-portal`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store", credentials: "omit", redirect: "error",
    signal: signal || AbortSignal.timeout(60000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const message = response.status === 401 ? "Sign in again to manage private access."
      : response.status === 503 ? "Private credential access is not available yet."
      : response.status === 429 ? "Please wait before trying again."
      : response.status === 409 ? "This request could not be completed. Refresh the invitation list before trying again."
      : "The request could not be completed. Refresh the invitation list to check its status.";
    const error = new Error(message);
    error.status = response.status;
    error.code = typeof result?.error === "string" ? result.error : null;
    throw error;
  }
  return result;
}

export const isPortalPreCreateRejection = error => [
  "invalid_invitation", "document_unavailable", "document_not_synced", "document_too_large", "selection_too_large", "invitation_limit",
].includes(error?.code);

export const portalDeliveryLabel = state => ({
  pending: "Email queued", sending: "Email submission in progress", sent: "Email accepted by provider",
  unknown: "Email submission uncertain", failed: "Email submission failed", suppressed: "Email cancelled",
}[state] || "Email status unavailable");

export function portalDocumentEligibility(doc) {
  if (!doc.storagePath) return "Sync this document before sharing";
  if (Number(doc.sizeBytes || doc.size || 0) > 10 * 1024 * 1024) return "Over the 10 MB limit";
  return null;
}
