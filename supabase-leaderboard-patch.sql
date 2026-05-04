-- Run this once in Supabase SQL Editor to let leaderboard details show weekly macros.
-- It exposes only calorie/macro totals and daily macro values, not notes, bodyweight, or photos.

create or replace function public.leaderboard_nutrition_for_week(target_week date)
returns table (
  user_id uuid,
  week_start date,
  calories numeric,
  protein numeric,
  carbs numeric,
  fat numeric,
  goals jsonb,
  days jsonb,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    n.user_id,
    n.week_start,
    n.calories,
    n.protein,
    n.carbs,
    n.fat,
    coalesce(n.payload -> 'goals', '{}'::jsonb) as goals,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'calories', day_item.day -> 'calories',
          'protein', day_item.day -> 'protein',
          'carbs', day_item.day -> 'carbs',
          'fat', day_item.day -> 'fat'
        )
        order by day_item.ordinality
      )
      from jsonb_array_elements(coalesce(n.payload -> 'days', '[]'::jsonb)) with ordinality as day_item(day, ordinality)
    ), '[]'::jsonb) as days,
    n.updated_at
  from public.nutrition_weeks n
  where n.week_start = target_week
    and n.week_start <> date '1970-01-05';
$$;

revoke all on function public.leaderboard_nutrition_for_week(date) from public;
grant execute on function public.leaderboard_nutrition_for_week(date) to authenticated;
