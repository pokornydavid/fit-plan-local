-- Run this once in Supabase SQL Editor if Nutrition shows a cloud save error.
-- It adds the missing nutrition_weeks table and RLS policies.

create extension if not exists pgcrypto;

create table if not exists public.nutrition_weeks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  payload jsonb not null default '{}'::jsonb,
  calories numeric not null default 0,
  protein numeric not null default 0,
  carbs numeric not null default 0,
  fat numeric not null default 0,
  latest_weight numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start)
);

alter table public.nutrition_weeks enable row level security;

drop policy if exists "users read own nutrition" on public.nutrition_weeks;
drop policy if exists "users insert own nutrition" on public.nutrition_weeks;
drop policy if exists "users update own nutrition" on public.nutrition_weeks;
drop policy if exists "users delete own nutrition" on public.nutrition_weeks;

create policy "users read own nutrition"
  on public.nutrition_weeks for select
  using (auth.uid() = user_id);

create policy "users insert own nutrition"
  on public.nutrition_weeks for insert
  with check (auth.uid() = user_id);

create policy "users update own nutrition"
  on public.nutrition_weeks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users delete own nutrition"
  on public.nutrition_weeks for delete
  using (auth.uid() = user_id);

create index if not exists nutrition_weeks_user_week_idx
  on public.nutrition_weeks (user_id, week_start);
