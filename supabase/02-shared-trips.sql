-- Trip Expense Ledger — upgrade 2: shared trips (several people, one set of accounts).
-- Run this once, AFTER setup.sql: Supabase > SQL Editor > New query > paste all > Run.
-- Safe to run again. Keeps all existing trips, expenses and receipts.
--
-- Rules it sets up:
--   * The person who creates a trip is its owner. Only the owner can edit or delete the trip
--     and add or remove people.
--   * Everyone on a trip can see all its expenses and receipt photos, and add expenses.
--   * An expense can be edited or deleted by the person who entered it, or by the trip owner.

-- ---------- New expense fields ----------
-- paid_by:   who paid (a person on the trip). Empty = the person who entered it.
-- spent_for: whom it was for. Empty = the person who paid; 'shared' = split equally
--            between everyone on the trip; otherwise the id of one person on the trip.
alter table public.expenses add column if not exists paid_by uuid references auth.users (id) on delete set null;
alter table public.expenses add column if not exists spent_for text
  check (spent_for is null or spent_for = 'shared' or spent_for ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
create index if not exists expenses_receipts_gin on public.expenses using gin (receipts jsonb_path_ops);

-- ---------- People on each trip ----------
create table if not exists public.trip_members (
  trip_id  uuid not null references public.trips (id) on delete cascade,
  user_id  uuid not null references auth.users (id) on delete cascade,
  role     text not null default 'member' check (role in ('owner', 'member')),
  email    text not null default '',
  name     text not null default '' check (char_length(name) <= 60),  -- name shown in reports
  added_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
create index if not exists trip_members_user on public.trip_members (user_id);

-- Helper checks used by the access rules. "security definer" lets them look at the
-- membership table without tripping over its own access rules.
create or replace function public.is_trip_owner(p_trip uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trips t where t.id = p_trip and t.user_id = auth.uid());
$$;

create or replace function public.is_trip_member(p_trip uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members m where m.trip_id = p_trip and m.user_id = auth.uid())
      or exists (select 1 from public.trips t where t.id = p_trip and t.user_id = auth.uid());
$$;

-- The creator of a trip is automatically its owner.
create or replace function public.ledger_add_owner_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.trip_members (trip_id, user_id, role, email, name)
  select new.id, new.user_id, 'owner', coalesce(u.email, ''), left(split_part(coalesce(u.email, ''), '@', 1), 60)
  from auth.users u where u.id = new.user_id
  on conflict (trip_id, user_id) do nothing;
  return new;
end $$;

drop trigger if exists trips_add_owner on public.trips;
create trigger trips_add_owner after insert on public.trips
  for each row execute function public.ledger_add_owner_member();

-- Existing trips: make their creators the owners.
insert into public.trip_members (trip_id, user_id, role, email, name)
select t.id, t.user_id, 'owner', coalesce(u.email, ''), left(split_part(coalesce(u.email, ''), '@', 1), 60)
from public.trips t join auth.users u on u.id = t.user_id
on conflict (trip_id, user_id) do nothing;

-- Most-recent-edit-wins, plus: an expense never changes who entered it or which trip it belongs to.
create or replace function public.ledger_keep_latest()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated_at < old.updated_at then
      return null;               -- older edit: keep what is stored
    end if;
    new.user_id := old.user_id;  -- ownership / author never changes
    if tg_table_name = 'expenses' then
      new.trip_id := old.trip_id;
    end if;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end $$;

-- ---------- Access rules ----------
alter table public.trip_members enable row level security;

drop policy if exists "Own trips" on public.trips;
drop policy if exists "Trips: people on the trip can read" on public.trips;
drop policy if exists "Trips: owner creates" on public.trips;
drop policy if exists "Trips: owner edits" on public.trips;
drop policy if exists "Trips: owner deletes" on public.trips;
create policy "Trips: people on the trip can read" on public.trips for select to authenticated
  using (user_id = (select auth.uid()) or public.is_trip_member(id));
create policy "Trips: owner creates" on public.trips for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "Trips: owner edits" on public.trips for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Trips: owner deletes" on public.trips for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Own expenses" on public.expenses;
drop policy if exists "Expenses: people on the trip can read" on public.expenses;
drop policy if exists "Expenses: people on the trip can add" on public.expenses;
drop policy if exists "Expenses: author or trip owner edits" on public.expenses;
drop policy if exists "Expenses: author or trip owner deletes" on public.expenses;
create policy "Expenses: people on the trip can read" on public.expenses for select to authenticated
  using (public.is_trip_member(trip_id));
-- (The owner may also save a row entered by someone else: that is how the owner's corrections upload.)
create policy "Expenses: people on the trip can add" on public.expenses for insert to authenticated
  with check (public.is_trip_member(trip_id) and (user_id = (select auth.uid()) or public.is_trip_owner(trip_id)));
create policy "Expenses: author or trip owner edits" on public.expenses for update to authenticated
  using (user_id = (select auth.uid()) or public.is_trip_owner(trip_id))
  with check (public.is_trip_member(trip_id));
create policy "Expenses: author or trip owner deletes" on public.expenses for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_trip_owner(trip_id));

drop policy if exists "Members: people on the trip can read" on public.trip_members;
drop policy if exists "Members: owner renames" on public.trip_members;
create policy "Members: people on the trip can read" on public.trip_members for select to authenticated
  using (public.is_trip_member(trip_id));
create policy "Members: owner renames" on public.trip_members for update to authenticated
  using (public.is_trip_owner(trip_id)) with check (public.is_trip_owner(trip_id));
-- People are added and removed only through the two functions below; only the display name can be edited directly.
revoke insert, update, delete on public.trip_members from anon, authenticated;
grant select on public.trip_members to authenticated;
grant update (name) on public.trip_members to authenticated;

-- ---------- Adding and removing people (trip owner only) ----------
create or replace function public.add_trip_member(p_trip uuid, p_email text, p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_email text;
begin
  if not public.is_trip_owner(p_trip) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  select u.id, u.email into v_user, v_email from auth.users u
   where lower(u.email) = lower(trim(p_email)) limit 1;
  if v_user is null then
    raise exception 'no_account';
  end if;
  insert into public.trip_members (trip_id, user_id, role, email, name)
  values (p_trip, v_user, 'member', v_email, left(coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1)), 60))
  on conflict (trip_id, user_id) do update set name = excluded.name
    where public.trip_members.role <> 'owner';
  -- Re-stamp the trip and its expenses so the new person's next sync downloads them.
  update public.trips set synced_at = clock_timestamp() where id = p_trip;
  update public.expenses set synced_at = clock_timestamp() where trip_id = p_trip;
  return json_build_object('user_id', v_user, 'email', v_email);
end $$;

create or replace function public.remove_trip_member(p_trip uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_trip_owner(p_trip) then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  delete from public.trip_members where trip_id = p_trip and user_id = p_user and role <> 'owner';
end $$;

revoke execute on function public.add_trip_member(uuid, text, text) from public, anon;
revoke execute on function public.remove_trip_member(uuid, uuid) from public, anon;
grant execute on function public.add_trip_member(uuid, text, text) to authenticated;
grant execute on function public.remove_trip_member(uuid, uuid) to authenticated;

-- ---------- Receipt photos: people on a trip can open each other's receipts ----------
drop policy if exists "Own receipts: read" on storage.objects;
drop policy if exists "Receipts: own or on a shared trip" on storage.objects;
create policy "Receipts: own or on a shared trip" on storage.objects for select to authenticated
  using (
    bucket_id = 'receipts' and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.expenses e
        where e.receipts @> jsonb_build_array(jsonb_build_object('id', split_part(name, '/', 2)))
          and public.is_trip_member(e.trip_id)
      )
    )
  );
-- Adding, replacing and deleting files stays limited to each person's own folder (setup.sql).
