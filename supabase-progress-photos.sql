-- Run this once in Supabase SQL Editor to enable cloud posing photos.
-- It creates a private Storage bucket plus metadata table and RLS policies.

create extension if not exists pgcrypto;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'progress-photos',
  'progress-photos',
  false,
  3145728,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.progress_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  phase_row_id text not null,
  week_label text not null default '',
  storage_path text not null unique,
  file_name text not null default 'Posing photo',
  width int not null default 0,
  height int not null default 0,
  file_size int not null default 0,
  content_type text not null default 'image/jpeg',
  created_at timestamptz not null default now()
);

alter table public.progress_photos enable row level security;

drop policy if exists "users read own progress photos" on public.progress_photos;
drop policy if exists "users insert own progress photos" on public.progress_photos;
drop policy if exists "users update own progress photos" on public.progress_photos;
drop policy if exists "users delete own progress photos" on public.progress_photos;

create policy "users read own progress photos"
  on public.progress_photos for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users insert own progress photos"
  on public.progress_photos for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users update own progress photos"
  on public.progress_photos for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users delete own progress photos"
  on public.progress_photos for delete
  to authenticated
  using (auth.uid() = user_id);

create index if not exists progress_photos_user_row_idx
  on public.progress_photos (user_id, phase_row_id, created_at);

drop policy if exists "progress photos read own files" on storage.objects;
drop policy if exists "progress photos insert own files" on storage.objects;
drop policy if exists "progress photos update own files" on storage.objects;
drop policy if exists "progress photos delete own files" on storage.objects;

create policy "progress photos read own files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'progress-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "progress photos insert own files"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'progress-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "progress photos update own files"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'progress-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'progress-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "progress photos delete own files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'progress-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
