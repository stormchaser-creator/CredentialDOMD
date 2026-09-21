import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createLifetimeGiftHandler } from '../_shared/lifetimeGiftReservations.mjs';
import { lifetimeGiftDependencies } from '../_shared/lifetimeGiftDependencies.ts';

serve(createLifetimeGiftHandler(lifetimeGiftDependencies()));
