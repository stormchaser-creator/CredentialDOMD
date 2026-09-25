// send-invoice-email: email an invoice from docs@credentialdomd.com with its
// line breaks intact (tickets e8cc2a02, 821d2f76). The rules and the request
// shapes are documented in ../_shared/invoiceEmailHandler.mjs; the I/O is in
// ../_shared/invoiceEmailDependencies.ts.
//
// Deploy with --no-verify-jwt (scripts/deploy-clerk-functions.sh does): the
// gateway cannot check Clerk RS256 tokens, so _shared/clerkAuth.ts verifies
// them here. Apply migration 20260925130000_invoice_email_sends.sql first:
// without its ledger every send refuses with 503 and nothing is mailed.
import { createInvoiceEmailHandler } from "../_shared/invoiceEmailHandler.mjs";
import { invoiceEmailDependencies } from "../_shared/invoiceEmailDependencies.ts";

Deno.serve(createInvoiceEmailHandler(invoiceEmailDependencies()));
