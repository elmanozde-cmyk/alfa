-- İzim: yürüyüş tablosu ve erişim kuralları
-- Supabase → SQL Editor → New query → bu metnin tamamını yapıştır → Run

create table if not exists public.walks (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  start_at   timestamptz not null,
  data       jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists walks_user_updated on public.walks (user_id, updated_at);

-- Her kayıt değiştiğinde zamanı güncelle (diğer cihazlar değişikliği buradan anlar)
create or replace function public.walks_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists walks_touch on public.walks;
create trigger walks_touch
  before insert or update on public.walks
  for each row execute function public.walks_touch();

-- Herkes sadece kendi yürüyüşlerini görebilir ve değiştirebilir
alter table public.walks enable row level security;

drop policy if exists "walks_select_own" on public.walks;
drop policy if exists "walks_insert_own" on public.walks;
drop policy if exists "walks_update_own" on public.walks;
drop policy if exists "walks_delete_own" on public.walks;

create policy "walks_select_own" on public.walks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "walks_insert_own" on public.walks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "walks_update_own" on public.walks
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "walks_delete_own" on public.walks
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.walks from anon;
grant select, insert, update, delete on public.walks to authenticated;
