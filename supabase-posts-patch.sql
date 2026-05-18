-- Run this once in Supabase SQL editor to enable the Posty tab.
-- It creates community text/photo posts and a private Storage bucket for post photos.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'community-posts',
  'community-posts',
  false,
  3145728,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null default date_trunc('week', now() at time zone 'Europe/Prague')::date,
  pinned boolean not null default false,
  body text not null default '',
  image_storage_path text,
  image_name text not null default '',
  image_width int not null default 0,
  image_height int not null default 0,
  image_size int not null default 0,
  content_type text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (body <> '' or image_storage_path is not null)
);

alter table public.community_posts
  add column if not exists week_start date;

alter table public.community_posts
  add column if not exists pinned boolean not null default false;

update public.community_posts
set week_start = date_trunc('week', created_at at time zone 'Europe/Prague')::date
where week_start is null;

alter table public.community_posts
  alter column week_start set default date_trunc('week', now() at time zone 'Europe/Prague')::date,
  alter column week_start set not null;

alter table public.community_posts enable row level security;

drop policy if exists "community posts readable" on public.community_posts;
drop policy if exists "users insert own community posts" on public.community_posts;
drop policy if exists "users update own community posts" on public.community_posts;
drop policy if exists "users delete own community posts" on public.community_posts;

create policy "community posts readable"
  on public.community_posts for select
  to authenticated
  using (true);

create policy "users insert own community posts"
  on public.community_posts for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users update own community posts"
  on public.community_posts for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users delete own community posts"
  on public.community_posts for delete
  to authenticated
  using (auth.uid() = user_id);

create index if not exists community_posts_recent_idx
  on public.community_posts (created_at desc);

create index if not exists community_posts_week_recent_idx
  on public.community_posts (week_start, created_at desc);

create index if not exists community_posts_pinned_recent_idx
  on public.community_posts (pinned, created_at desc);

create index if not exists community_posts_user_recent_idx
  on public.community_posts (user_id, created_at desc);

drop policy if exists "community posts read files" on storage.objects;
drop policy if exists "community posts insert own files" on storage.objects;
drop policy if exists "community posts update own files" on storage.objects;
drop policy if exists "community posts delete own files" on storage.objects;

create policy "community posts read files"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'community-posts');

create policy "community posts insert own files"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'community-posts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "community posts update own files"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'community-posts'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'community-posts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "community posts delete own files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'community-posts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
