-- Trip Expense Ledger — database setup for Supabase.
-- Run this once: Supabase dashboard > SQL Editor > New query > paste all of this > Run.
-- Safe to run again: it only creates what is missing.

-- ---------- Tables ----------
create table if not exists public.trips (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 120),
  destination   text not null default '',
  purpose       text not null default '',
  start_date    date not null,
  end_date      date not null,
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  base_exp      smallint not null check (base_exp between 0 and 4),
  created_at    timestamptz not null,
  updated_at    timestamptz not null,           -- when it was last edited, on whichever device
  deleted       boolean not null default false, -- deletions are kept so they reach every device
  synced_at     timestamptz not null default now(), -- set by the server; devices pull changes after this
  check (end_date >= start_date)
);

create table if not exists public.expenses (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trip_id       uuid not null references public.trips (id) on delete cascade,
  date          date not null,
  category      text not null,
  description   text not null check (char_length(description) between 1 and 160),
  merchant      text not null default '',
  payment       text not null,
  reimbursable  boolean not null default false,
  receipt       boolean not null default false,
  notes         text not null default '',
  currency      text not null check (currency ~ '^[A-Z]{3}$'),
  exp           smallint not null check (exp between 0 and 4),
  -- Amounts are whole numbers of the currency's smallest unit (e.g. sen, cents, fils).
  amount_minor  bigint not null check (amount_minor <> 0 and abs(amount_minor) < 9000000000000000),
  -- Rate kept as exact text: 1 unit of `currency` = `rate` units of `base_currency`.
  rate          text not null check (rate ~ '^[0-9]+(\.[0-9]{1,12})?$'),
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  base_exp      smallint not null check (base_exp between 0 and 4),
  base_minor    bigint not null check (abs(base_minor) < 9000000000000000),
  receipts      jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null,
  updated_at    timestamptz not null,
  deleted       boolean not null default false,
  synced_at     timestamptz not null default now()
);

create index if not exists trips_user_synced on public.trips (user_id, synced_at);
create index if not exists expenses_user_synced on public.expenses (user_id, synced_at);
create index if not exists expenses_trip on public.expenses (trip_id);

-- ---------- Most recent edit wins ----------
-- If a device uploads an older version of a record than the one already stored,
-- the upload is ignored. Every accepted write gets a fresh synced_at.
create or replace function public.ledger_keep_latest()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated_at < old.updated_at then
      return null;               -- older edit: keep what is stored
    end if;
    new.user_id := old.user_id;  -- ownership never changes
  end if;
  new.synced_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists trips_keep_latest on public.trips;
create trigger trips_keep_latest before insert or update on public.trips
  for each row execute function public.ledger_keep_latest();

drop trigger if exists expenses_keep_latest on public.expenses;
create trigger expenses_keep_latest before insert or update on public.expenses
  for each row execute function public.ledger_keep_latest();

-- ---------- Access: each person sees and changes only their own rows ----------
alter table public.trips enable row level security;
alter table public.expenses enable row level security;

drop policy if exists "Own trips" on public.trips;
create policy "Own trips" on public.trips for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "Own expenses" on public.expenses;
create policy "Own expenses" on public.expenses for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- Receipt photo storage (private) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 20971520, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

-- Files are stored as <user id>/<file id>; each person can only reach their own folder.
drop policy if exists "Own receipts: read" on storage.objects;
create policy "Own receipts: read" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Own receipts: add" on storage.objects;
create policy "Own receipts: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Own receipts: replace" on storage.objects;
create policy "Own receipts: replace" on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Own receipts: delete" on storage.objects;
create policy "Own receipts: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
