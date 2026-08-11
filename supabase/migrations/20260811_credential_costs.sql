-- Cost tracking on credentials: what each license renewal costs, and
-- society dues + renewal date on professional memberships (CNS/AANS/AOA).
alter table public.licenses add column if not exists renewal_cost numeric;
alter table public.professional_memberships add column if not exists cost numeric;
alter table public.professional_memberships add column if not exists expiration_date date;
