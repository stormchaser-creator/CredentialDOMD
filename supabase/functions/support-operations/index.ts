// Staged internal broker. No scheduler or existing route calls this function.
// Deploy later with gateway JWT checks disabled: dedicated internal credentials,
// owner Clerk verification and signed Resend webhooks are checked inside.
import { createSupportHandler } from '../_shared/supportHandlers.mjs';
import { supportDependencies } from '../_shared/supportDependencies.ts';
Deno.serve(createSupportHandler(supportDependencies()));
