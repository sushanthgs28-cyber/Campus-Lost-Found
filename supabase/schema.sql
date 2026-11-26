-- Campus Lost & Found: database schema, security rules and server functions.
-- Run this whole file once in Supabase: SQL Editor > New query > paste > Run.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

-- ---------- settings ----------
create table if not exists public.settings (key text primary key, value text not null);
alter table public.settings enable row level security;          -- no policies: clients cannot read it
insert into public.settings values ('allowed_email_domain', 'reva.edu.in') on conflict do nothing;
-- Change the allowed sign-up domain here if REVA uses another one:
--   update public.settings set value = 'your-domain.edu' where key = 'allowed_email_domain';
-- Set value to '' to allow any email (testing only).

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'student' check (role in ('student','admin')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles readable by signed-in users" on public.profiles for select to authenticated using (true);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare dom text;
begin
  select value into dom from public.settings where key = 'allowed_email_domain';
  if dom is not null and dom <> '' and lower(split_part(new.email, '@', 2)) <> lower(dom) then
    raise exception 'Only % email addresses can sign up', dom;
  end if;
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name',''), split_part(new.email, '@', 1)));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

-- ---------- items ----------
create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('lost','found')),
  name text not null check (char_length(name) between 1 and 60),
  category text not null default 'Other',
  place text not null check (char_length(place) between 1 and 60),
  description text not null default '' check (char_length(description) <= 400),
  happened_on date,
  happened_time time,
  held_at text,
  handover text not null default 'Security desk',
  photo_path text,
  status text not null default 'open' check (status in ('open','claimed','matched','returned')),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  claimer_id uuid references public.profiles(id) on delete set null,
  embedding extensions.vector(512),
  created_at timestamptz not null default now(),
  returned_at timestamptz
);
create index if not exists items_status_idx on public.items (status, created_at desc);
create index if not exists items_owner_idx on public.items (owner_id);
alter table public.items enable row level security;
create policy "items readable by signed-in users" on public.items for select to authenticated using (true);
-- No insert/update/delete policies: all changes go through the functions below.

-- Secrets: the hash of the hidden detail and the finder's contact. Nobody can read this table directly.
create table if not exists public.item_secrets (
  item_id uuid primary key references public.items(id) on delete cascade,
  detail_hash text not null,
  finder_contact text
);
alter table public.item_secrets enable row level security;

create table if not exists public.claim_attempts (
  item_id uuid references public.items(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  tries int not null default 0,
  primary key (item_id, user_id)
);
alter table public.claim_attempts enable row level security;

create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  claimer_id uuid not null references public.profiles(id) on delete cascade,
  contact text not null,
  note text,
  created_at timestamptz not null default now()
);
alter table public.claims enable row level security;
create policy "claims visible to claimer, item owner and admins" on public.claims for select to authenticated
  using (claimer_id = auth.uid() or public.is_admin()
         or exists (select 1 from public.items i where i.id = item_id and i.owner_id = auth.uid()));

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  lost_item_id uuid not null references public.items(id) on delete cascade,
  found_item_id uuid not null references public.items(id) on delete cascade,
  score double precision not null,
  created_at timestamptz not null default now(),
  unique (lost_item_id, found_item_id)
);
alter table public.matches enable row level security;
create policy "matches visible to the two posters and admins" on public.matches for select to authenticated
  using (public.is_admin()
         or exists (select 1 from public.items i where i.id in (lost_item_id, found_item_id) and i.owner_id = auth.uid()));

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 300),
  created_at timestamptz not null default now()
);
alter table public.reports enable row level security;
create policy "reports visible to admins" on public.reports for select to authenticated using (public.is_admin());

-- ---------- helper ----------
create or replace function public.norm(t text) returns text language sql immutable as $$
  select lower(regexp_replace(btrim(coalesce(t,'')), '\s+', ' ', 'g'))
$$;

-- ---------- functions the web app calls ----------
create or replace function public.create_item(
  p_kind text, p_name text, p_category text, p_place text, p_description text,
  p_happened_on date, p_happened_time time, p_held_at text, p_handover text,
  p_photo_path text, p_detail text, p_finder_contact text
) returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare new_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if p_kind not in ('lost','found') then raise exception 'Invalid kind'; end if;
  if public.norm(p_detail) = '' then raise exception 'A hidden detail is required'; end if;
  insert into public.items (id, kind, name, category, place, description, happened_on, happened_time, held_at, handover, photo_path, owner_id)
  values (new_id, p_kind, btrim(p_name), coalesce(nullif(p_category,''),'Other'), btrim(p_place), coalesce(p_description,''),
          p_happened_on, p_happened_time, case when p_kind = 'found' then p_held_at end,
          coalesce(nullif(p_handover,''),'Security desk'), p_photo_path, auth.uid());
  insert into public.item_secrets (item_id, detail_hash, finder_contact)
  values (new_id, encode(extensions.digest(new_id::text || ':' || public.norm(p_detail), 'sha256'), 'hex'),
          case when p_kind = 'found' then nullif(btrim(p_finder_contact),'') end);
  return new_id;
end $$;

create or replace function public.claim_item(p_item uuid, p_detail text, p_contact text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare it public.items; sec public.item_secrets; t int;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if btrim(coalesce(p_contact,'')) = '' then raise exception 'Add a contact'; end if;
  select * into it from public.items where id = p_item for update;
  if not found or it.kind <> 'found' or it.status <> 'open' then raise exception 'This item cannot be claimed'; end if;
  if it.owner_id = auth.uid() then raise exception 'You posted this item'; end if;
  select coalesce(tries,0) into t from public.claim_attempts where item_id = p_item and user_id = auth.uid();
  if coalesce(t,0) >= 3 then return jsonb_build_object('ok', false, 'locked', true, 'tries_left', 0); end if;
  select * into sec from public.item_secrets where item_id = p_item;
  if encode(extensions.digest(p_item::text || ':' || public.norm(p_detail), 'sha256'), 'hex') <> sec.detail_hash then
    insert into public.claim_attempts (item_id, user_id, tries) values (p_item, auth.uid(), 1)
      on conflict (item_id, user_id) do update set tries = public.claim_attempts.tries + 1;
    return jsonb_build_object('ok', false, 'locked', false, 'tries_left', 2 - coalesce(t,0));
  end if;
  update public.items set status = 'claimed', claimer_id = auth.uid() where id = p_item;
  insert into public.claims (item_id, claimer_id, contact) values (p_item, auth.uid(), btrim(p_contact));
  return jsonb_build_object('ok', true, 'finder_contact', sec.finder_contact, 'handover', it.handover, 'held_at', it.held_at);
end $$;

create or replace function public.respond_lost(p_item uuid, p_note text, p_contact text)
returns void language plpgsql security definer set search_path = public as $$
declare it public.items;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if btrim(coalesce(p_contact,'')) = '' then raise exception 'Add a contact'; end if;
  select * into it from public.items where id = p_item for update;
  if not found or it.kind <> 'lost' or it.status <> 'open' then raise exception 'This item cannot be answered'; end if;
  if it.owner_id = auth.uid() then raise exception 'You posted this item'; end if;
  update public.items set status = 'matched', claimer_id = auth.uid() where id = p_item;
  insert into public.claims (item_id, claimer_id, contact, note) values (p_item, auth.uid(), btrim(p_contact), left(coalesce(p_note,''), 200));
end $$;

create or replace function public.item_contacts(p_item uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare it public.items; fc text; cc text; cn text; allowed boolean;
begin
  select * into it from public.items where id = p_item;
  if not found then return '{}'::jsonb; end if;
  allowed := it.owner_id = auth.uid() or it.claimer_id = auth.uid() or public.is_admin();
  if not allowed then return '{}'::jsonb; end if;
  if it.kind = 'found' and it.status in ('claimed','returned') then
    select finder_contact into fc from public.item_secrets where item_id = p_item;
  end if;
  if it.owner_id = auth.uid() or public.is_admin() then
    select contact, note into cc, cn from public.claims where item_id = p_item order by created_at desc limit 1;
  end if;
  return jsonb_build_object('finder_contact', fc, 'claimer_contact', cc, 'claimer_note', cn);
end $$;

create or replace function public.set_status(p_item uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare it public.items;
begin
  if p_status not in ('open','returned') then raise exception 'Invalid status'; end if;
  select * into it from public.items where id = p_item for update;
  if not found then raise exception 'Not found'; end if;
  if it.owner_id <> auth.uid() and not public.is_admin() then raise exception 'Not allowed'; end if;
  if p_status = 'returned' then
    update public.items set status = 'returned', returned_at = now() where id = p_item;
  else
    update public.items set status = 'open', claimer_id = null, returned_at = null where id = p_item;
    delete from public.claim_attempts where item_id = p_item;
  end if;
end $$;

create or replace function public.delete_item(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.items where id = p_item and (owner_id = auth.uid() or public.is_admin())) then
    raise exception 'Not allowed';
  end if;
  delete from public.items where id = p_item;
end $$;

create or replace function public.report_item(p_item uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.reports (item_id, reporter_id, reason) values (p_item, auth.uid(), left(btrim(p_reason), 300));
end $$;

-- Used only by the AI service (service role): nearest open items of the opposite kind.
create or replace function public.match_items(query_embedding extensions.vector(512), opposite_kind text, cat text, n int default 5)
returns table (id uuid, name text, score double precision)
language sql stable security definer set search_path = public, extensions as $$
  select i.id, i.name, 1 - (i.embedding <=> query_embedding) as score
  from public.items i
  where i.kind = opposite_kind and i.status = 'open' and i.embedding is not null
    and (cat is null or i.category = cat)
  order by i.embedding <=> query_embedding
  limit n
$$;

-- Delete old returned posts (run from pg_cron or by hand): select public.cleanup_returned(30);
create or replace function public.cleanup_returned(days int default 30) returns int
language plpgsql security definer set search_path = public as $$
declare c int;
begin
  delete from public.items where status = 'returned' and returned_at < now() - make_interval(days => days);
  get diagnostics c = row_count; return c;
end $$;

-- ---------- permissions on functions ----------
revoke all on function public.create_item(text,text,text,text,text,date,time,text,text,text,text,text) from public, anon;
revoke all on function public.claim_item(uuid,text,text) from public, anon;
revoke all on function public.respond_lost(uuid,text,text) from public, anon;
revoke all on function public.item_contacts(uuid) from public, anon;
revoke all on function public.set_status(uuid,text) from public, anon;
revoke all on function public.delete_item(uuid) from public, anon;
revoke all on function public.report_item(uuid,text) from public, anon;
revoke all on function public.match_items(extensions.vector,text,text,int) from public, anon, authenticated;
revoke all on function public.cleanup_returned(int) from public, anon, authenticated;
grant execute on function public.create_item(text,text,text,text,text,date,time,text,text,text,text,text) to authenticated;
grant execute on function public.claim_item(uuid,text,text) to authenticated;
grant execute on function public.respond_lost(uuid,text,text) to authenticated;
grant execute on function public.item_contacts(uuid) to authenticated;
grant execute on function public.set_status(uuid,text) to authenticated;
grant execute on function public.delete_item(uuid) to authenticated;
grant execute on function public.report_item(uuid,text) to authenticated;
grant execute on function public.match_items(extensions.vector,text,text,int) to service_role;

-- ---------- photos ----------
insert into storage.buckets (id, name, public) values ('item-photos', 'item-photos', true) on conflict (id) do nothing;
create policy "photo upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'item-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos readable" on storage.objects for select using (bucket_id = 'item-photos');

-- ---------- live updates ----------
alter publication supabase_realtime add table public.items;

-- ---------- make yourself an admin (replace the email, run once after you sign up) ----------
-- update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'you@reva.edu.in');
