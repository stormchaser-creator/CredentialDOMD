import { createCredentialPortalHandler } from '../_shared/credentialPortalHandler.mjs';
import { credentialPortalDependencies } from '../_shared/credentialPortalDependencies.ts';

// The Supabase JWT gateway cannot validate the Clerk or opaque recipient token.
// Future deployment must disable gateway JWT verification; the handler verifies both itself.
// Code-level policy and runtime flag both remain disabled until reviewed activation.
Deno.serve(createCredentialPortalHandler(credentialPortalDependencies()));
