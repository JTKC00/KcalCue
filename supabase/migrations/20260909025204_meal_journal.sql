-- Meal records contain versioned, provider-neutral snapshots. No image bytes are stored in SQL.
create table public.meals (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  version integer not null check (version > 0),
  record jsonb not null,
  totals jsonb not null,
  deleted_at timestamptz,
  check (jsonb_typeof(record) = 'object'),
  check ((record->>'id')::uuid = id),
  check ((record->>'userId')::uuid = user_id),
  check ((record->>'version')::integer = version),
  check (record->>'mode' in ('manual', 'live')),
  check (deleted_at is not null or jsonb_array_length(record->'items') between 1 and 12)
);
create index meals_owner_date on public.meals (user_id, date desc, id) where deleted_at is null;
alter table public.meals enable row level security;
revoke all on public.meals from anon;
grant select, insert, update on public.meals to authenticated;
create policy meals_read on public.meals for select to authenticated using ((select auth.uid()) = user_id);
create policy meals_insert on public.meals for insert to authenticated with check ((select auth.uid()) = user_id and version = 1 and deleted_at is null);
create policy meals_update on public.meals for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create function public.check_meal_version() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.user_id <> old.user_id or new.id <> old.id or old.deleted_at is not null then
    raise exception 'immutable meal';
  end if;
  if new.deleted_at is not null then
    if new.version <> old.version then raise exception 'invalid deletion'; end if;
  elsif new.version <> old.version + 1 then
    raise exception 'invalid version';
  end if;
  return new;
end;
$$;
revoke execute on function public.check_meal_version() from public, anon, authenticated;
create trigger meal_version_guard before update on public.meals for each row execute function public.check_meal_version();

-- Uploads can precede the meal save; rows also track failed uploads for explicit cleanup.
create table public.meal_photos (
  path text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  meal_id uuid not null,
  ready boolean not null default false,
  created_at timestamptz not null default now(),
  check (split_part(path, '/', 1) = user_id::text),
  check (split_part(path, '/', 2) = meal_id::text),
  check (path ~ '^[a-f0-9-]+/[a-f0-9-]+/[a-f0-9-]+\.jpg$')
);
create index meal_photos_owner_meal on public.meal_photos (user_id, meal_id);
alter table public.meal_photos enable row level security;
revoke all on public.meal_photos from anon;
grant select, insert, update, delete on public.meal_photos to authenticated;
create policy photos_read on public.meal_photos for select to authenticated using ((select auth.uid()) = user_id);
create policy photos_insert on public.meal_photos for insert to authenticated with check ((select auth.uid()) = user_id);
create policy photos_update on public.meal_photos for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy photos_delete on public.meal_photos for delete to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meal-photos', 'meal-photos', false, 5242880, array['image/jpeg']);
create policy meal_storage_read on storage.objects for select to authenticated
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy meal_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.meal_photos p where p.path = name and p.user_id = (select auth.uid())));
create policy meal_storage_delete on storage.objects for delete to authenticated
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
