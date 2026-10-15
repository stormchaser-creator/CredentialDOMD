#!/usr/bin/env node
// The owned local public fixture for manually operated browsers. Its API
// proxy enforces the original functions' CORS across a separate origin.
import { startPublicSite } from './e2e/support/bill-admin-support-public-helpers.mjs';
const site = await startPublicSite({ nativeBrowser: true });
console.log(JSON.stringify({ purpose: 'Native-browser local QA only', origin: site.origin, apiOrigin: site.nativeApiOrigin }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await site.close(); process.exit(0); });
