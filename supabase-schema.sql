-- Run this in Supabase SQL editor after creating the project.
-- It gives the app login, profiles, public feed data, and leaderboard data.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workout_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  day_index int not null check (day_index between 0 and 6),
  title text not null default '',
  focus text not null default '',
  notes text not null default '',
  visibility text not null default 'public' check (visibility in ('private', 'public')),
  payload jsonb not null default '{}'::jsonb,
  volume numeric not null default 0,
  completed_sets int not null default 0,
  total_sets int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start, day_index)
);

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

alter table public.profiles enable row level security;
alter table public.workout_days enable row level security;
alter table public.nutrition_weeks enable row level security;

drop policy if exists "profiles are public readable" on public.profiles;
drop policy if exists "users insert own profile" on public.profiles;
drop policy if exists "users update own profile" on public.profiles;

create policy "profiles are public readable"
  on public.profiles for select
  using (true);

create policy "users insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "users update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "users read own workouts" on public.workout_days;
drop policy if exists "users read public workouts" on public.workout_days;
drop policy if exists "users insert own workouts" on public.workout_days;
drop policy if exists "users update own workouts" on public.workout_days;
drop policy if exists "users delete own workouts" on public.workout_days;

create policy "users read own workouts"
  on public.workout_days for select
  using (auth.uid() = user_id);

create policy "users read public workouts"
  on public.workout_days for select
  using (visibility = 'public');

create policy "users insert own workouts"
  on public.workout_days for insert
  with check (auth.uid() = user_id);

create policy "users update own workouts"
  on public.workout_days for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users delete own workouts"
  on public.workout_days for delete
  using (auth.uid() = user_id);

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

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    lower(split_part(new.email, '@', 1)) || '-' || substr(new.id::text, 1, 4),
    split_part(new.email, '@', 1)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create index if not exists workout_days_user_week_idx
  on public.workout_days (user_id, week_start);

create index if not exists workout_days_public_recent_idx
  on public.workout_days (visibility, updated_at desc)
  where visibility = 'public';

create index if not exists nutrition_weeks_user_week_idx
  on public.nutrition_weeks (user_id, week_start);
