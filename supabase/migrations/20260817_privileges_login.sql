alter table public.privileges add column if not exists portal_url text, add column if not exists login_username text, add column if not exists login_secret text;
comment on column public.privileges.login_secret is 'Client-side AES-GCM ciphertext (enc1:...) keyed by a device-held lock code; never plaintext.';
select column_name from information_schema.columns where table_name='privileges' and column_name like 'login%' or (table_name='privileges' and column_name='portal_url');;
