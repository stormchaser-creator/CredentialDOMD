import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createMailboxRepairHandler } from '../_shared/mailboxRepair.mjs';
import { mailboxRepairDependencies } from '../_shared/mailboxRepairDependencies.ts';

serve(createMailboxRepairHandler(mailboxRepairDependencies()));
