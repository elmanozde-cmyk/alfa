-- İzim: Polar bağlantı tablosu
-- Supabase → SQL Editor → New query → bu metnin tamamını yapıştır → Run
-- (Önce schema.sql çalıştırılmış olmalı.)

create table if not exists public.polar_links (
  user_id       uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  polar_user_id bigint      not null,
  access_token  text        not null,
  linked_at     timestamptz not null default now(),
  last_sync     timestamptz
);

-- Herkes sadece kendi Polar bağlantısını görebilir
alter table public.polar_links enable row level security;

drop policy if exists "polar_select_own" on public.polar_links;
drop policy if exists "polar_insert_own" on public.polar_links;
drop policy if exists "polar_update_own" on public.polar_links;
drop policy if exists "polar_delete_own" on public.polar_links;

create policy "polar_select_own" on public.polar_links
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "polar_insert_own" on public.polar_links
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "polar_update_own" on public.polar_links
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "polar_delete_own" on public.polar_links
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.polar_links from anon;
grant select, insert, update, delete on public.polar_links to authenticated;
