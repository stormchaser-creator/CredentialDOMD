import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createAdminLifetimeAccessHandler } from '../_shared/adminLifetimeAccess.mjs';
import { adminLifetimeDependencies } from '../_shared/adminLifetimeDependencies.ts';

serve(createAdminLifetimeAccessHandler(adminLifetimeDependencies()));
