-- A fourth inbound route: contacts@credentialdomd.com.
--
-- An iPhone cannot hand a contact card to a web app. iOS has no Contact Picker
-- API and Safari ignores the Web Share Target manifest, so nothing in the share
-- sheet can reach this app directly. What the share sheet does have is Mail,
-- which is what a physician asked for: "share a contact straight into
-- references, the way I share to text or email". Share Contact > Mail >
-- contacts@ lands the .vcf here and the reference is written for him.
--
-- Widening a CHECK, so every row already in the table still satisfies it.
alter table public.inbound_emails
  drop constraint if exists inbound_emails_route_check;

alter table public.inbound_emails
  add constraint inbound_emails_route_check
  check (route = any (array['cme'::text, 'docs'::text, 'forward'::text, 'contacts'::text]));
