// Synthetic email template for the link checker's extraction test.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
const html = `<p>Renew at <a href="https://renew.board-fixture.gov/apply">the board</a>.</p>`;
const api = "https://npiregistry.cms.hhs.gov/api/?version=2.1";
export default { serve, html, api };
