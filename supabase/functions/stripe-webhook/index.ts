import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createBillingHandlers } from '../_shared/billingHandlers.mjs';
import { billingDependencies } from '../_shared/billingDependencies.ts';
// Signature verification occurs against the raw body inside the handler.
serve(createBillingHandlers(billingDependencies()).webhook);
